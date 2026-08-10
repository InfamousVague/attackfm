// AttackFM's CarPlay surface. See carplay.m for the whole story.
#pragma once

#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

// Rust -> native: the webview's library, as JSON. Safe to call from any
// thread; the store hops to main before touching UIKit.
void afm_carplay_set_library(const char *json);

// Rust -> native: what is playing right now, as JSON. Feeds the system
// now-playing center, which is what CarPlay's Now Playing screen, the lock
// screen, and the Control Center tile all read.
void afm_carplay_set_now_playing(const char *json);

// Rust -> native: parks (or restores) the OS idle timer, so the phone does
// not auto-lock while the app's full-screen player is up. The webview draws
// its own dim; this only keeps the lock away.
void afm_set_idle_timer_disabled(int disabled);

// native -> Rust: a track picked on the car screen. `context` names the list
// it was picked from ("liked", "songs", "artist:<name>"), which is what the
// webview builds the play queue from.
extern void afm_carplay_play_track(long long track_id, const char *context);

// native -> Rust: a transport command from the car or the lock screen:
// "play", "pause", "next", "previous", or "seek:<seconds>".
extern void afm_carplay_remote(const char *command);

#ifdef __cplusplus
}
#endif
