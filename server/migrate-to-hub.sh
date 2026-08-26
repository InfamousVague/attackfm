#!/usr/bin/env bash
#
# Move this Mac's library and database up to the AttackFM server box.
#
# Run it HERE, on the Mac that holds the library:
#
#     bash server/migrate-to-hub.sh preflight    # look, measure, change nothing
#     bash server/migrate-to-hub.sh sync         # hours. re-runnable, interruptible
#     bash server/migrate-to-hub.sh cutover      # minutes. stops the server briefly
#     bash server/migrate-to-hub.sh status       # what is up there vs down here
#
# WHY THREE STEPS, AND NOT ONE.
#
# The library is large and a home upload is slow, so the bulk of the bytes have
# to move while the server is still serving - which means the copy is racing
# writes the whole way. `sync` therefore makes no claim to be complete. It just
# gets most of the bytes across, and you can run it as many times as you like:
# each pass is cheaper than the last because rsync only sends what changed.
#
# `cutover` is the short window that DOES have to be consistent: the server is
# stopped, nothing can change underneath, and the final delta goes up together
# with the database. That window is minutes, not hours, precisely because every
# earlier `sync` already moved the bulk.
#
# WHAT MAKES THIS SAFE TO INTERRUPT. Nothing is ever deleted on either side -
# there is no --delete anywhere in here. A killed transfer resumes from its
# partial file. The database is never copied as a live file; it is snapshotted
# with sqlite3 .backup, which is the only way to read a WAL-mode database
# consistently while something might still hold it open.

set -euo pipefail

# --- where things are ------------------------------------------------------

# The destination's PUBLIC address, deliberately. This Mac is behind CGNAT, but
# CGNAT only blocks INBOUND - an outbound push needs no tunnel at all, and going
# direct avoids WireGuard's overhead on a link where upload is the scarce thing.
# Override if you would rather it went over the tailnet: DEST_HOST=attackfm-metal
DEST_HOST="${DEST_HOST:-149.248.47.151}"
DEST_USER="${DEST_USER:-root}"
DEST_MUSIC="${DEST_MUSIC:-/srv/music}"
DEST_DATA="${DEST_DATA:-/opt/attackfm/data}"

LABEL="com.mattssoftware.attackfm-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Leave the link usable while this runs. 0 means "no limit"; a number is KB/s.
# On a home connection an unlimited rsync will happily eat the entire upload and
# make the house's internet unusable for a day, which is a good way to be told
# to stop. 0 is the default because the right answer depends on the line.
BWLIMIT="${BWLIMIT:-0}"

SSH_KEY="$HOME/.ssh/attackfm_hub"

# --- how this looks --------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
	GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m')
	CYAN=$(printf '\033[36m'); YELLOW=$(printf '\033[33m')
else
	B=''; DIM=''; R=''; GREEN=''; RED=''; CYAN=''; YELLOW=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸%s %s%s%s\n' "$CYAN" "$R" "$B" "$*" "$R"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$R" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$R" "$*"; }
die()  { printf '\n%s✗%s %s\n\n' "$RED" "$R" "$*" >&2; exit 1; }

# --- reading this Mac's own configuration ----------------------------------

# The plist is the source of truth for where the library is, because it is what
# the running server was actually told. Asking it beats asking the person: the
# answer cannot drift from what is being served.
plist_env() {
	/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true
}

load_config() {
	[ -f "$PLIST" ] || die "No $PLIST - is the server installed on this Mac? (server/home-install.sh)"
	MUSIC_DIR="$(plist_env AFM_MUSIC_DIR)"
	DATA_DIR="$(plist_env AFM_DATA_DIR)"
	[ -n "$MUSIC_DIR" ] && [ -d "$MUSIC_DIR" ] || die "AFM_MUSIC_DIR ('$MUSIC_DIR') is not a directory."
	[ -n "$DATA_DIR" ]  && [ -d "$DATA_DIR" ]  || die "AFM_DATA_DIR ('$DATA_DIR') is not a directory."
	DB="$DATA_DIR/attackfm.db"
}

# --- ssh ------------------------------------------------------------------

# A key, made once, so the hours-long transfer is never sitting at a password
# prompt and a resumed run needs no hands. The first run asks for the box's
# password exactly once, to install the key.
ensure_key() {
	if [ ! -f "$SSH_KEY" ]; then
		step "Making an SSH key for the hub (one time)"
		ssh-keygen -t ed25519 -N '' -C "attackfm-hub-$(hostname -s)" -f "$SSH_KEY" >/dev/null
		ok "wrote $SSH_KEY"
	fi
	if ! ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
	        -o ConnectTimeout=15 "$DEST_USER@$DEST_HOST" true 2>/dev/null; then
		step "Installing that key on $DEST_HOST"
		say "  ${DIM}You will be asked for the server's root password once.${R}"
		ssh-copy-id -i "$SSH_KEY.pub" -o StrictHostKeyChecking=accept-new \
			"$DEST_USER@$DEST_HOST" >/dev/null
		ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 \
			"$DEST_USER@$DEST_HOST" true \
			|| die "Key installed but the box still refuses it."
		ok "key accepted"
	fi
}

hub() { ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20 "$DEST_USER@$DEST_HOST" "$@"; }

SSH_E() { printf 'ssh -i %s -o BatchMode=yes -o ConnectTimeout=20' "$SSH_KEY"; }

# --- rsync ----------------------------------------------------------------

# MACOS DOES NOT SHIP A USABLE RSYNC ANY MORE, and this is the trap that costs a
# whole transfer if you do not check for it.
#
# `/usr/bin/rsync` is now openrsync, which announces itself as "rsync version
# 2.6.9 compatible" and then rejects almost every long option: no --exclude, no
# --partial, no --info=progress2, and no --copy-unsafe-links. A 180GB transfer
# with no resume and no excludes is not a transfer, it is a lottery.
#
# Worse, openrsync's symlink handling differs from GNU rsync's, so the one thing
# this migration cannot get wrong - the audiobooks symlink - behaves differently
# depending on which binary ran. Rather than write for two dialects, insist on
# the real one.
RSYNC=""
find_rsync() {
	local c v
	for c in /opt/homebrew/bin/rsync /usr/local/bin/rsync "$(command -v rsync || true)"; do
		[ -n "$c" ] && [ -x "$c" ] || continue
		v="$("$c" --version 2>/dev/null | head -1)"
		case "$v" in
			*"version 3."*) RSYNC="$c"; return 0 ;;
		esac
	done
	die "No GNU rsync 3.x found - /usr/bin/rsync on modern macOS is openrsync,
    which cannot resume, cannot exclude, and handles the audiobooks symlink
    differently. Install the real one and re-run:

        brew install rsync"
}

# THE FLAG THAT MATTERS MOST IS --copy-unsafe-links.
#
# home-install.sh links the audiobooks folder INTO the library rather than
# moving it, so `$MUSIC_DIR/audiobooks` is usually a symlink pointing somewhere
# outside the tree being copied. A plain -a copies that symlink verbatim, and
# the far side gets a dangling link where several hundred hours of books should
# be - a failure that looks like success, because rsync reports no error and the
# byte count is merely "smaller than expected".
#
# --copy-unsafe-links copies the REFERENT for links that escape the tree, and
# leaves links that stay inside the tree as links. That is exactly the rule we
# want, and it is why -L (follow everything) is not used instead.
rsync_common() {
	printf '%s' "-a --copy-unsafe-links --partial --human-readable --info=progress2,stats1 \
--exclude=.DS_Store --exclude=._* --exclude=.Spotlight-V100 --exclude=.fseventsd \
--exclude=.TemporaryItems --exclude=.Trashes --exclude=lost+found"
}

bw() { [ "$BWLIMIT" != "0" ] && printf -- "--bwlimit=%s" "$BWLIMIT" || printf ''; }

# --- the steps -------------------------------------------------------------

do_preflight() {
	load_config
	find_rsync
	step "This Mac"
	say "  music   $MUSIC_DIR"
	say "  data    $DATA_DIR"
	say "  server  $(launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo running || echo 'not running')"

	step "Measuring the library (this walks the tree; give it a minute)"
	# -L so the audiobooks symlink is measured as its contents, matching what
	# will actually be sent.
	local msize mcount
	msize=$(du -shL "$MUSIC_DIR" 2>/dev/null | cut -f1)
	mcount=$(find -L "$MUSIC_DIR" -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')
	say "  library     $msize across $mcount files"
	if [ -L "$MUSIC_DIR/audiobooks" ]; then
		say "  audiobooks  ${DIM}symlink -> $(readlink "$MUSIC_DIR/audiobooks") (will be followed)${R}"
	fi
	[ -f "$DB" ] && say "  database    $(du -h "$DB" | cut -f1)  $(sqlite3 "$DB" 'pragma quick_check;' 2>/dev/null | head -1)"

	step "Reaching the hub"
	ensure_key
	local free
	free=$(hub "df -h $DEST_MUSIC | tail -1 | awk '{print \$4}'")
	ok "$DEST_HOST reachable - $free free on $DEST_MUSIC"

	step "Rough time"
	say "  ${DIM}Measuring upload speed with a 24MB probe...${R}"
	local t0 t1 secs mbps
	t0=$(date +%s)
	dd if=/dev/zero bs=1m count=24 2>/dev/null | \
		ssh -i "$SSH_KEY" -o BatchMode=yes "$DEST_USER@$DEST_HOST" "cat > /dev/null"
	t1=$(date +%s); secs=$(( t1 - t0 )); [ "$secs" -lt 1 ] && secs=1
	mbps=$(echo "scale=1; 24 * 8 / $secs" | bc 2>/dev/null || echo '?')
	say "  upload      ~${mbps} Mbit/s"
	if [ "$mbps" != "?" ]; then
		local gb hours
		gb=$(du -sLk "$MUSIC_DIR" 2>/dev/null | awk '{print $1/1048576}')
		hours=$(echo "scale=1; $gb * 8192 / $mbps / 3600" | bc 2>/dev/null || echo '?')
		say "  estimate    ~${hours} hours for the first pass"
	fi

	step "Nothing has been changed"
	say "  Next:  ${B}bash server/migrate-to-hub.sh sync${R}"
	say "  ${DIM}The server keeps running. Interrupt and re-run whenever you like.${R}"
}

do_sync() {
	load_config
	find_rsync
	ensure_key
	step "Bulk copy - the server stays up"
	say "  ${DIM}Safe to interrupt (ctrl-C) and safe to re-run. Nothing is deleted.${R}"
	[ "$BWLIMIT" != "0" ] && say "  ${DIM}limited to ${BWLIMIT} KB/s${R}"
	say ""
	# caffeinate: a 20-hour transfer that dies because the lid closed is the
	# single most likely way this goes wrong.
	caffeinate -is "$RSYNC" $(rsync_common) $(bw) \
		-e "$(SSH_E)" \
		"$MUSIC_DIR/" "$DEST_USER@$DEST_HOST:$DEST_MUSIC/"
	ok "pass complete"
	step "What now"
	say "  Run ${B}sync${R} again to pick up anything that changed, as often as you like."
	say "  When a pass finishes quickly, you are ready for ${B}cutover${R}."
}

do_cutover() {
	load_config
	find_rsync
	ensure_key
	step "Cutover - the server WILL stop for a few minutes"
	printf "  Continue? [y/N]: "
	read -r yn; case "$yn" in [Yy]*) ;; *) die "Nothing done." ;; esac

	step "Stopping the local server"
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	sleep 2
	ok "stopped - nothing can write to the library or the database now"

	step "Final delta of the library"
	caffeinate -is "$RSYNC" $(rsync_common) $(bw) \
		-e "$(SSH_E)" \
		"$MUSIC_DIR/" "$DEST_USER@$DEST_HOST:$DEST_MUSIC/"
	ok "library is level"

	step "Snapshotting the database"
	# .backup rather than cp: this is a WAL database, and a file copy of one is a
	# torn copy unless every writer is provably gone. .backup is consistent by
	# construction and costs a couple of seconds on a file this size.
	local snap="$DATA_DIR/attackfm-migrate.db"
	rm -f "$snap"
	sqlite3 "$DB" ".backup '$snap'"
	[ "$(sqlite3 "$snap" 'pragma integrity_check;' | head -1)" = "ok" ] \
		|| die "The snapshot did not verify. Nothing has been sent; the local server is still stopped - restart it with: launchctl bootstrap gui/\$(id -u) $PLIST"
	ok "$(du -h "$snap" | cut -f1), integrity ok"

	step "Sending the database and the rest of the data directory"
	"$RSYNC" $(rsync_common) -e "$(SSH_E)" \
		--exclude='attackfm.db' --exclude='attackfm.db-wal' --exclude='attackfm.db-shm' \
		--exclude='attackfm-migrate.db' \
		"$DATA_DIR/" "$DEST_USER@$DEST_HOST:$DEST_DATA/"
	"$RSYNC" -a --human-readable --info=progress2 -e "$(SSH_E)" \
		"$snap" "$DEST_USER@$DEST_HOST:$DEST_DATA/attackfm.db.incoming"
	ok "uploaded"

	step "Swapping it in on the hub"
	hub "set -e
		systemctl stop attackfm
		cd $DEST_DATA
		[ -f attackfm.db ] && mv attackfm.db attackfm.db.pre-migration
		rm -f attackfm.db-wal attackfm.db-shm
		mv attackfm.db.incoming attackfm.db
		chown attackfm:attackfm attackfm.db
		chown -R attackfm:attackfm $DEST_MUSIC || true
		systemctl start attackfm"
	ok "hub restarted on the migrated database"

	step "Checking the two sides agree"
	local here there
	for t in users tracks listens playlists; do
		here=$(sqlite3 "$snap" "select count(*) from $t;" 2>/dev/null || echo '-')
		there=$(hub "sqlite3 $DEST_DATA/attackfm.db 'select count(*) from $t;'" 2>/dev/null || echo '-')
		if [ "$here" = "$there" ]; then
			printf "  %s %-12s %s\n" "$GREEN✓$R" "$t" "$here"
		else
			printf "  %s %-12s here=%s hub=%s\n" "$RED✗$R" "$t" "$here" "$there"
		fi
	done
	rm -f "$snap"

	step "Done here - two things left, and they are not on this Mac"
	say "  1. Point matt.attack.fm at the hub's own server instead of this Mac:"
	say "     ${DIM}in the hub's /etc/caddy/Caddyfile, the matt.attack.fm handle{} block${R}"
	say "     ${DIM}currently proxies to headless-mac...ts.net - change it to${R}"
	say "     ${DIM}reverse_proxy 127.0.0.1:8788, then: systemctl reload caddy${R}"
	say "  2. Raise AFM_QUOTA_GB on the hub - it is still 110, sized for the old box."
	say ""
	say "  ${B}This Mac's server is still stopped.${R} That is deliberate: two servers"
	say "  writing to two copies of the same library is how they diverge. Start it"
	say "  again only if you are rolling back:"
	say "     ${DIM}launchctl bootstrap gui/\$(id -u) $PLIST${R}"
}

do_status() {
	load_config
	ensure_key
	step "Here"
	say "  library  $(du -shL "$MUSIC_DIR" 2>/dev/null | cut -f1)"
	say "  server   $(launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo running || echo stopped)"
	[ -f "$DB" ] && say "  tracks   $(sqlite3 "$DB" 'select count(*) from tracks;' 2>/dev/null)"
	step "Hub ($DEST_HOST)"
	hub "echo \"  library  \$(du -sh $DEST_MUSIC 2>/dev/null | cut -f1)\"
	     echo \"  free     \$(df -h $DEST_MUSIC | tail -1 | awk '{print \\\$4}')\"
	     echo \"  service  \$(systemctl is-active attackfm)\"
	     echo \"  tracks   \$(sqlite3 $DEST_DATA/attackfm.db 'select count(*) from tracks;' 2>/dev/null)\""
}

case "${1:-}" in
	preflight) do_preflight ;;
	sync)      do_sync ;;
	cutover)   do_cutover ;;
	status)    do_status ;;
	*)
		say "Usage: bash server/migrate-to-hub.sh {preflight|sync|cutover|status}"
		say ""
		say "  preflight   measure everything, change nothing"
		say "  sync        bulk copy while the server keeps running (hours, re-runnable)"
		say "  cutover     stop the server, send the last delta and the database (minutes)"
		say "  status      compare this Mac and the hub"
		say ""
		say "Environment: DEST_HOST=$DEST_HOST  BWLIMIT=${BWLIMIT} (KB/s, 0 = unlimited)"
		exit 1
		;;
esac
