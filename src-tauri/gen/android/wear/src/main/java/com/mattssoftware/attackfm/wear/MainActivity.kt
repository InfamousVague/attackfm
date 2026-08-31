package com.mattssoftware.attackfm.wear

import android.graphics.BitmapFactory
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * AttackFM on the wrist, second cut: Glacier's clothes, Lucide's icons, Wear's
 * own manners.
 *
 * The first cut proved the wiring and looked like it. This one is the design
 * pass: the standard Wear scaffold (the time at the top, a position indicator,
 * a vignette), real vector icons instead of emoji glyphs, the track's own art
 * as the remote's face, and controls sized for the round screen rather than
 * poured into it.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = Store(this)
        setContent { GlacierTheme { Root(store) } }
    }
}

@Composable
private fun Root(store: Store) {
    var signedIn by remember { mutableStateOf(store.token != null) }
    val listState = rememberScalingLazyListState()
    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        if (!signedIn) {
            SignIn(store, listState) { signedIn = true }
        } else {
            Remote(store, listState) {
                store.signOut()
                signedIn = false
            }
        }
    }
}

// --- sign in -----------------------------------------------------------------

/** Six digits on a phone-style pad; rows of three fit the circle. */
@Composable
private fun SignIn(store: Store, listState: ScalingLazyListState, onDone: () -> Unit) {
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun submit() {
        if (busy || code.length < 4) return
        busy = true
        error = null
        scope.launch {
            try {
                val (token, streamToken, _) = withContext(Dispatchers.IO) { Net.claim(store.url, code) }
                store.token = token
                store.streamToken = streamToken
                onDone()
            } catch (e: Exception) {
                error = e.message ?: "could not sign in"
                code = ""
            } finally {
                busy = false
            }
        }
    }

    ScalingLazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().background(Glacier.bg),
    ) {
        item {
            Icon(
                Lucide.Watch,
                contentDescription = null,
                tint = Glacier.accent,
                modifier = Modifier.size(22.dp),
            )
        }
        item {
            Text(
                "Link this watch",
                color = Glacier.text,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
        }
        item {
            Text(
                "Settings → Link a device",
                color = Glacier.textMuted,
                fontSize = 10.sp,
                textAlign = TextAlign.Center,
            )
        }
        item {
            // Six seats, filling as digits land - dots hold what is still owed.
            val shown = code.padEnd(6, '·').toCharArray().joinToString(" ")
            Text(
                shown,
                color = if (error != null) MaterialTheme.colors.error else Glacier.accent,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(vertical = 2.dp),
            )
        }
        error?.let { e ->
            item {
                Text(
                    e,
                    color = MaterialTheme.colors.error,
                    fontSize = 9.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
        }
        items("123456789".chunked(3)) { row -> PadRow(row) { if (code.length < 6) code += it } }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), modifier = Modifier.fillMaxWidth()) {
                PadKey(icon = Lucide.Delete, label = "Delete") { code = code.dropLast(1) }
                PadKey(text = "0") { if (code.length < 6) code += "0" }
                PadKey(icon = Lucide.Check, label = "Sign in", accent = true, enabled = !busy && code.length >= 4) { submit() }
            }
        }
        item { Spacer(Modifier.height(18.dp)) }
    }
}

@Composable
private fun PadRow(keys: String, onKey: (Char) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        modifier = Modifier.fillMaxWidth().padding(vertical = 1.dp),
    ) {
        keys.forEach { ch -> PadKey(text = ch.toString()) { onKey(ch) } }
    }
}

@Composable
private fun PadKey(
    text: String? = null,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    label: String? = null,
    accent: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = if (accent) ButtonDefaults.primaryButtonColors() else ButtonDefaults.secondaryButtonColors(),
        modifier = Modifier.size(38.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = label, modifier = Modifier.size(15.dp))
        } else {
            Text(text ?: "", fontSize = 14.sp, fontWeight = FontWeight.Medium)
        }
    }
}

// --- the remote --------------------------------------------------------------

@Composable
private fun Remote(store: Store, listState: ScalingLazyListState, onSignOut: () -> Unit) {
    var state by remember { mutableStateOf<SeatState?>(null) }
    var live by remember { mutableStateOf(false) }
    var meta by remember { mutableStateOf<Map<Long, TrackMeta>>(emptyMap()) }
    var liked by remember { mutableStateOf<List<Long>>(emptyList()) }

    val client = remember {
        ConnectClient(
            url = store.url,
            streamToken = store.streamToken ?: "",
            deviceId = "wear-" + android.os.Build.MODEL.hashCode().toString(16),
            onState = { s -> state = s; live = true },
            onDown = { live = false },
        )
    }
    DisposableEffect(Unit) {
        client.open()
        onDispose { client.close() }
    }

    val wantIds = (listOfNotNull(state?.trackId) + liked).distinct()
    LaunchedEffect(wantIds) {
        val missing = wantIds.filter { it !in meta }
        if (missing.isEmpty()) return@LaunchedEffect
        val token = store.token ?: return@LaunchedEffect
        val got = withContext(Dispatchers.IO) {
            runCatching { Net.tracks(store.url, token, missing) }.getOrDefault(emptyMap())
        }
        if (got.isNotEmpty()) meta = meta + got
    }
    LaunchedEffect(Unit) {
        val token = store.token ?: return@LaunchedEffect
        liked = withContext(Dispatchers.IO) {
            runCatching { Net.favorites(store.url, token) }.getOrDefault(emptyList())
        }
    }

    val now = state?.trackId?.let { meta[it] }

    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize().background(Glacier.bg)) {
        // The face: the track's own art as a disc, or the music mark waiting.
        item { TrackDisc(store, state?.trackId, size = 64.dp) }
        item {
            Text(
                when {
                    !live -> "Reaching your server…"
                    state?.trackId == null -> "Nothing playing"
                    else -> now?.title ?: "…"
                },
                color = Glacier.text,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 22.dp),
            )
        }
        if (now != null) {
            item {
                Text(
                    now.artist,
                    color = Glacier.textMuted,
                    fontSize = 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 26.dp),
                )
            }
        }
        item {
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                Button(
                    onClick = { client.command("prev") },
                    colors = ButtonDefaults.secondaryButtonColors(),
                    modifier = Modifier.size(40.dp),
                ) { Icon(Lucide.SkipBack, "Previous", modifier = Modifier.size(16.dp)) }
                Button(
                    onClick = { client.command("toggle") },
                    modifier = Modifier.size(54.dp),
                ) {
                    Icon(
                        if (state?.playing == true) Lucide.Pause else Lucide.Play,
                        if (state?.playing == true) "Pause" else "Play",
                        modifier = Modifier.size(22.dp),
                    )
                }
                Button(
                    onClick = { client.command("next") },
                    colors = ButtonDefaults.secondaryButtonColors(),
                    modifier = Modifier.size(40.dp),
                ) { Icon(Lucide.SkipForward, "Next", modifier = Modifier.size(16.dp)) }
            }
        }
        state?.volume?.let { vol ->
            item {
                InlineSlider(
                    value = vol.toFloat(),
                    onValueChange = { v -> client.command("volume") { it.put("volume", v.toDouble()) } },
                    valueRange = 0f..1f,
                    steps = 9,
                    decreaseIcon = { Icon(Lucide.Minus, "Quieter", modifier = Modifier.size(14.dp)) },
                    increaseIcon = { Icon(Lucide.Plus, "Louder", modifier = Modifier.size(14.dp)) },
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
        }
        if (liked.isNotEmpty()) {
            item {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
                    modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 2.dp),
                ) {
                    Icon(Lucide.Heart, null, tint = Glacier.accent, modifier = Modifier.size(11.dp))
                    Text("Liked", color = Glacier.textMuted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                }
            }
            items(liked.take(50)) { id ->
                val t = meta[id]
                Chip(
                    onClick = {
                        client.command("setQueue") { c ->
                            c.put("queue", org.json.JSONArray(liked))
                            c.put("index", liked.indexOf(id))
                        }
                    },
                    icon = { TrackDisc(store, id, size = 26.dp) },
                    label = {
                        Text(t?.title ?: "…", fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    secondaryLabel = t?.let {
                        { Text(it.artist, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item {
            CompactChip(
                onClick = onSignOut,
                icon = { Icon(Lucide.LogOut, null, modifier = Modifier.size(12.dp)) },
                label = { Text("Sign out", fontSize = 10.sp) },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.padding(top = 10.dp),
            )
        }
        item { Spacer(Modifier.height(20.dp)) }
    }
}

// --- art ---------------------------------------------------------------------

/** In-memory covers for the session; a watch list holds a few dozen at most. */
private val artCache = HashMap<Long, ImageBitmap?>()

/**
 * A track's cover as a circle, with the Lucide music mark holding the seat
 * while (or if ever) the bytes arrive. One fetch per track per process.
 */
@Composable
private fun TrackDisc(store: Store, trackId: Long?, size: androidx.compose.ui.unit.Dp) {
    var art by remember(trackId) { mutableStateOf(artCache[trackId]) }
    LaunchedEffect(trackId) {
        if (trackId == null || artCache.containsKey(trackId)) return@LaunchedEffect
        val streamToken = store.streamToken ?: return@LaunchedEffect
        val got = withContext(Dispatchers.IO) {
            runCatching {
                val req = Request.Builder().url(Net.artUrl(store.url, streamToken, trackId)).build()
                Net.http.newCall(req).execute().use { r ->
                    if (!r.isSuccessful) null
                    else r.body?.bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
                }
            }.getOrNull()
        }
        artCache[trackId] = got
        art = got
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier.size(size).clip(CircleShape).background(Glacier.surface),
    ) {
        val a = art
        if (a != null) {
            Image(a, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Icon(
                Lucide.Music,
                contentDescription = null,
                tint = Glacier.textMuted,
                modifier = Modifier.size(size / 2),
            )
        }
    }
}
