package com.mattssoftware.attackfm.wear

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The watch's whole wire life: one HTTP client, the pair-code claim, the light
 * metadata asks, and the Connect socket.
 *
 * Everything speaks to the hub the SAME doors the phone does - pair/claim for a
 * session with no password (nobody types a password on a bezel), /api/tracks
 * for names, /api/connect for the live seat. The watch is a REMOTE: it never
 * streams a byte of audio; it steers whichever device holds the seat.
 */

/** Where the session lives between launches. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("attackfm-wear", Context.MODE_PRIVATE)

    var url: String
        get() = prefs.getString("url", "https://matt.attack.fm") ?: "https://matt.attack.fm"
        set(v) { prefs.edit().putString("url", v.trimEnd('/')).apply() }

    var token: String?
        get() = prefs.getString("token", null)
        set(v) { prefs.edit().putString("token", v).apply() }

    var streamToken: String?
        get() = prefs.getString("streamToken", null)
        set(v) { prefs.edit().putString("streamToken", v).apply() }

    fun signOut() { prefs.edit().remove("token").remove("streamToken").apply() }
}

data class TrackMeta(
    val id: Long,
    val title: String,
    val artist: String,
    val artId: String?,
    val durationMs: Long?,
)

object Net {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // The Connect socket idles between state changes; without this OkHttp
        // would shoot it for quietness.
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private val json = "application/json".toMediaType()

    /** One-time pairing code -> a full session. The same door the phone's
     *  "log in with a code" walks. Throws with the server's own words. */
    fun claim(url: String, code: String): Triple<String, String, String> {
        val body = JSONObject().put("code", code.trim()).toString().toRequestBody(json)
        val req = Request.Builder().url("$url/api/pair/claim").post(body).build()
        http.newCall(req).execute().use { r ->
            val text = r.body?.string() ?: ""
            if (!r.isSuccessful) throw RuntimeException(text.ifBlank { "the server refused (${r.code})" })
            val o = JSONObject(text)
            val user = o.getJSONObject("user").getString("username")
            return Triple(o.getString("token"), o.getString("streamToken"), user)
        }
    }

    /** The light metadata for a handful of ids - a remote's whole library view. */
    fun tracks(url: String, token: String, ids: List<Long>): Map<Long, TrackMeta> {
        if (ids.isEmpty()) return emptyMap()
        val req = Request.Builder()
            .url("$url/api/tracks?ids=${ids.joinToString(",")}")
            .header("authorization", "Bearer $token")
            .build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) return emptyMap()
            val arr = JSONObject(r.body?.string() ?: return emptyMap()).optJSONArray("tracks") ?: return emptyMap()
            val out = HashMap<Long, TrackMeta>()
            for (i in 0 until arr.length()) {
                val t = arr.getJSONObject(i)
                out[t.getLong("id")] = TrackMeta(
                    id = t.getLong("id"),
                    title = t.optString("title"),
                    artist = t.optString("artist"),
                    artId = t.optString("artId").takeIf { it.isNotEmpty() && it != "null" },
                    durationMs = if (t.isNull("durationMs")) null else t.getLong("durationMs"),
                )
            }
            return out
        }
    }

    /** The liked list, ids only - names come from [tracks]. */
    fun favorites(url: String, token: String): List<Long> {
        val req = Request.Builder()
            .url("$url/api/favorites")
            .header("authorization", "Bearer $token")
            .build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) return emptyList()
            val text = r.body?.string() ?: return emptyList()
            val o = JSONObject(text)
            // The server says {"tracks":[ids]} - see api::favorites.
            val arr = o.optJSONArray("tracks") ?: return emptyList()
            return (0 until arr.length()).map { arr.getLong(it) }
        }
    }

    /** The cover for a track, sized for a watch. */
    fun artUrl(url: String, streamToken: String, trackId: Long): String =
        "$url/api/art/track/$trackId?t=$streamToken&size=160"
}

/** What the hub says the account's playback looks like right now. */
data class SeatState(
    val trackId: Long?,
    val positionMs: Long,
    val playing: Boolean,
    val volume: Double?,
    val queue: List<Long>,
    val queueIndex: Int?,
)

/**
 * The Connect socket, kept simple: connect, say hello as a watch, mirror every
 * state frame into [onState], and push transport commands. Reconnects itself
 * with a short backoff - a watch walks in and out of coverage for a living.
 */
class ConnectClient(
    private val url: String,
    private val streamToken: String,
    private val deviceId: String,
    private val onState: (SeatState) -> Unit,
    private val onDown: () -> Unit,
) {
    private var ws: WebSocket? = null
    @Volatile private var closed = false

    fun open() {
        closed = false
        dial()
    }

    private fun dial() {
        val wsUrl = url.replace("https://", "wss://").replace("http://", "ws://")
        val req = Request.Builder().url("$wsUrl/api/connect?t=$streamToken").build()
        ws = Net.http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(
                    JSONObject()
                        .put("type", "hello")
                        .put("id", deviceId)
                        .put("name", "Watch")
                        .put("kind", "watch")
                        .toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val o = runCatching { JSONObject(text) }.getOrNull() ?: return
                if (o.optString("type") != "state") return
                val s = o.optJSONObject("state") ?: return
                val queue = s.optJSONArray("queue")
                onState(
                    SeatState(
                        trackId = if (s.isNull("trackId")) null else s.optLong("trackId"),
                        positionMs = s.optLong("positionMs"),
                        playing = s.optBoolean("playing"),
                        volume = if (s.isNull("volume")) null else s.optDouble("volume"),
                        queue = queue?.let { q -> (0 until q.length()).map { q.getLong(it) } } ?: emptyList(),
                        queueIndex = if (s.isNull("queueIndex")) null else s.optInt("queueIndex"),
                    ),
                )
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (closed) return
                onDown()
                // Out of coverage, hub restarting, doesn't matter which: try
                // again shortly, forever, quietly.
                Thread { Thread.sleep(4000); if (!closed) dial() }.start()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closed) onFailure(webSocket, RuntimeException(reason), null)
            }
        })
    }

    fun command(action: String, build: (JSONObject) -> Unit = {}) {
        val cmd = JSONObject().put("action", action)
        build(cmd)
        ws?.send(JSONObject().put("type", "command").put("command", cmd).toString())
    }

    fun close() {
        closed = true
        ws?.close(1000, "bye")
    }
}
