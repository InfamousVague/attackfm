package com.mattssoftware.attackfm

/**
 * Whether a published version is worth a notification, with nothing Android in it.
 *
 * Kept apart from the worker for one reason: these few comparisons are the
 * whole difference between a feature and a nuisance. Get one wrong and the
 * phone either buzzes every six hours about the version it is already running,
 * or never buzzes at all - and neither failure shows up anywhere except in a
 * listener's tray. Pure functions can be tested on the JVM without an emulator
 * (see UpdateAlertRulesTest), so they live here.
 */
object UpdateAlertRules {
  /**
   * Dotted-numeric compare: is [a] strictly newer than [b]?
   *
   * The same reading appUpdate.ts's `newerVersion` and ship-update.mjs's
   * `cmpVersion` give a version, on purpose - if this side and the page
   * disagreed about which of two versions is newer, the notification would
   * promise an update that the app, once opened, declines to install. A part
   * that is not a number counts as 0, and a missing part is 0, so "0.7" and
   * "0.7.0" are the same version.
   */
  fun isNewer(a: String, b: String): Boolean {
    val pa = a.split('.').map { it.trim().toIntOrNull() ?: 0 }
    val pb = b.split('.').map { it.trim().toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(pa.size, pb.size)) {
      val d = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
      if (d != 0) return d > 0
    }
    return false
  }

  /**
   * Should [published] be announced?
   *
   * @param publishedNative the native generation the manifest says the bundle
   *   needs.
   * @param floors every version this device already has an answer for: the
   *   one the page last said it was running, the one bundles/state.json has
   *   staged for the next launch, and the one last announced. The published
   *   version has to beat ALL of them. Running is the obvious one; staged is
   *   what stops a notification for an update the app already downloaded
   *   while you were using it (it only needs a restart, and the app says so
   *   itself); last-announced is what stops the same version being announced
   *   every six hours until somebody opens the app. Nulls and blanks are
   *   ignored - a floor nobody has written yet is not a floor.
   * @param quarantined versions that failed to boot here. The app refuses to
   *   install them again, so announcing one would send somebody into an app
   *   that then does nothing.
   * @param nativeGeneration what this binary can run, as the page last
   *   reported it; 0 when never reported, which does not gate. A bundle that
   *   needs a newer binary is refused by the installer (bundle.rs, and
   *   checkForUpdate before it) for the same reason as a quarantined one: the
   *   tap would lead nowhere.
   */
  fun shouldNotify(
    published: String,
    publishedNative: Int,
    floors: List<String?>,
    quarantined: Collection<String>,
    nativeGeneration: Int,
  ): Boolean {
    if (published.isBlank()) return false
    if (published in quarantined) return false
    if (nativeGeneration > 0 && publishedNative > nativeGeneration) return false
    return floors.filterNotNull().filter { it.isNotBlank() }.all { isNewer(published, it) }
  }

  /**
   * The notification's body: the first [maxLines] notes, bullets stripped.
   *
   * The manifest's notes are CHANGELOG.md's section for the version, one
   * "- " bullet per line (ship-update.mjs folds wrapped continuations in
   * before publishing). The same strip appUpdate.ts's `notesLines` applies,
   * so the tray and the update card describe a release in the same words.
   * Two lines because a tray entry is a glance, not the changelog; the rest is
   * one tap away, in the app. Null when there is nothing to say, so the
   * caller can fall back to its own sentence.
   */
  fun body(notes: String?, maxLines: Int = 2): String? {
    if (notes.isNullOrBlank()) return null
    val lines = notes.split('\n')
      .map { it.replace(Regex("^\\s*[-*]\\s*"), "").trim() }
      .filter { it.isNotEmpty() }
      .take(maxLines)
    return if (lines.isEmpty()) null else lines.joinToString("\n")
  }
}
