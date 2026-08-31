package com.mattssoftware.attackfm.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * AttackFM on the wrist: a remote for the seat, in Glacier's clothes.
 *
 * Three faces, one activity. Sign in with a pairing code (Settings on any
 * signed-in device mints one - the same no-password door every device walks).
 * Then the seat: what is playing anywhere on the account, with transport that
 * steers whichever device holds it. Swipe up for Liked, where a tap hands the
 * seat's device a new queue.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = Store(this)
        setContent {
            GlacierTheme { Root(store) }
        }
    }
}

@Composable
private fun Root(store: Store) {
    var signedIn by remember { mutableStateOf(store.token != null) }
    if (!signedIn) {
        SignIn(store) { signedIn = true }
    } else {
        Remote(store) {
            store.signOut()
            signedIn = false
        }
    }
}

/**
 * The pairing code - six digits (make_code's alphabet is 0-9) - on a
 * phone-style pad. Rows of three, not five: a round face clips the ends of
 * any wider row, which on the first cut left 5 and 0 literally off the watch.
 */
@Composable
private fun SignIn(store: Store, onDone: () -> Unit) {
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
                val (token, streamToken, _) = withContext(Dispatchers.IO) {
                    Net.claim(store.url, code)
                }
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
        modifier = Modifier.fillMaxSize().background(Glacier.bg),
    ) {
        item {
            Text(
                "Link this watch",
                color = Glacier.text,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
        }
        item {
            Text(
                "Settings → Link a device\non your phone",
                color = Glacier.textMuted,
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
            )
        }
        item {
            Text(
                if (code.isEmpty()) "· · · · · ·" else code.chunked(3).joinToString(" "),
                color = if (error != null) MaterialTheme.colors.error else Glacier.accent,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
        error?.let { e ->
            item { Text(e, color = MaterialTheme.colors.error, fontSize = 10.sp, textAlign = TextAlign.Center) }
        }
        val alphabet = "1234567890"
        items(alphabet.chunked(3)) { row ->
            Row(horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                row.forEach { ch ->
                    CompactButton(
                        onClick = { if (code.length < 6) code += ch },
                        colors = ButtonDefaults.secondaryButtonColors(),
                        modifier = Modifier.padding(2.dp),
                    ) { Text(ch.toString(), fontSize = 14.sp) }
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                CompactButton(
                    onClick = { code = code.dropLast(1) },
                    colors = ButtonDefaults.secondaryButtonColors(),
                    modifier = Modifier.padding(2.dp),
                ) { Text("⌫") }
                CompactButton(
                    onClick = { submit() },
                    enabled = !busy && code.length >= 4,
                    modifier = Modifier.padding(2.dp),
                ) { Text(if (busy) "…" else "Go") }
            }
        }
    }
}

/** The seat, live. */
@Composable
private fun Remote(store: Store, onSignOut: () -> Unit) {
    var state by remember { mutableStateOf<SeatState?>(null) }
    var live by remember { mutableStateOf(false) }
    var meta by remember { mutableStateOf<Map<Long, TrackMeta>>(emptyMap()) }
    var liked by remember { mutableStateOf<List<Long>>(emptyList()) }
    val scope = rememberCoroutineScope()

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

    // Names for whatever the seat is on plus the liked list, fetched when the
    // ids change and never per frame.
    val wantIds = (listOfNotNull(state?.trackId) + liked).distinct()
    LaunchedEffect(wantIds) {
        val missing = wantIds.filter { it !in meta }
        if (missing.isEmpty()) return@LaunchedEffect
        val token = store.token ?: return@LaunchedEffect
        val got = withContext(Dispatchers.IO) { runCatching { Net.tracks(store.url, token, missing) }.getOrDefault(emptyMap()) }
        if (got.isNotEmpty()) meta = meta + got
    }
    LaunchedEffect(Unit) {
        val token = store.token ?: return@LaunchedEffect
        liked = withContext(Dispatchers.IO) { runCatching { Net.favorites(store.url, token) }.getOrDefault(emptyList()) }
    }

    val now = state?.trackId?.let { meta[it] }

    ScalingLazyColumn(modifier = Modifier.fillMaxSize().background(Glacier.bg)) {
        item {
            Text(
                when {
                    !live -> "Reaching your server…"
                    state?.trackId == null -> "Nothing playing"
                    else -> now?.title ?: "…"
                },
                color = Glacier.text,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 10.dp),
            )
        }
        if (now != null) {
            item { Text(now.artist, color = Glacier.textMuted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        item {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            ) {
                CompactButton(onClick = { client.command("prev") }, colors = ButtonDefaults.secondaryButtonColors()) {
                    Text("⏮")
                }
                Button(
                    onClick = { client.command("toggle") },
                    modifier = Modifier.size(52.dp).clip(CircleShape),
                ) {
                    Text(if (state?.playing == true) "⏸" else "▶", fontSize = 20.sp)
                }
                CompactButton(onClick = { client.command("next") }, colors = ButtonDefaults.secondaryButtonColors()) {
                    Text("⏭")
                }
            }
        }
        state?.volume?.let { vol ->
            item {
                InlineSlider(
                    value = vol.toFloat(),
                    onValueChange = { v ->
                        client.command("volume") { it.put("volume", v.toDouble()) }
                    },
                    valueRange = 0f..1f,
                    steps = 9,
                    decreaseIcon = { Text("−", color = Glacier.textMuted) },
                    increaseIcon = { Text("+", color = Glacier.textMuted) },
                )
            }
        }
        if (liked.isNotEmpty()) {
            item {
                Text(
                    "LIKED",
                    color = Glacier.textMuted,
                    fontSize = 10.sp,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }
            items(liked.take(50)) { id ->
                val t = meta[id]
                Chip(
                    onClick = {
                        // Hand the seat the liked list as its queue, from here.
                        client.command("setQueue") { c ->
                            c.put("queue", org.json.JSONArray(liked))
                            c.put("index", liked.indexOf(id))
                        }
                    },
                    label = { Text(t?.title ?: "…", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    secondaryLabel = t?.let { { Text(it.artist, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item {
            CompactButton(
                onClick = onSignOut,
                colors = ButtonDefaults.secondaryButtonColors(),
                modifier = Modifier.padding(top = 10.dp),
            ) { Text("Sign out", fontSize = 10.sp) }
        }
    }
}
