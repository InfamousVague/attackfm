package com.mattssoftware.attackfm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules that decide whether a phone buzzes about an update.
 *
 *   cd src-tauri/gen/android && ./gradlew :app:testDebugUnitTest --tests '*UpdateAlertRulesTest'
 *
 * Plain JVM: nothing here touches Android, which is the reason the rules were
 * pulled out of the worker in the first place.
 */
class UpdateAlertRulesTest {
  @Test
  fun newerIsNumericPerPartNotLexical() {
    assertTrue(UpdateAlertRules.isNewer("0.6.10", "0.6.9"))
    assertTrue(UpdateAlertRules.isNewer("0.7.0", "0.6.99"))
    assertTrue(UpdateAlertRules.isNewer("1.0.0", "0.99.99"))
    assertFalse(UpdateAlertRules.isNewer("0.6.9", "0.6.10"))
  }

  @Test
  fun equalIsNotNewerAndMissingPartsAreZero() {
    assertFalse(UpdateAlertRules.isNewer("0.6.8", "0.6.8"))
    assertFalse(UpdateAlertRules.isNewer("0.7", "0.7.0"))
    assertFalse(UpdateAlertRules.isNewer("0.7.0", "0.7"))
    assertTrue(UpdateAlertRules.isNewer("0.7.1", "0.7"))
  }

  @Test
  fun aPartThatIsNotANumberCountsAsZeroLikeThePage() {
    // appUpdate.ts reads a part with `Number(n) || 0`.
    assertFalse(UpdateAlertRules.isNewer("0.7.x", "0.7.0"))
    assertTrue(UpdateAlertRules.isNewer("0.7.1", "0.7.x"))
  }

  @Test
  fun announcesOnlyWhatBeatsEveryFloor() {
    val q = emptyList<String>()
    // Newer than running, nothing staged, never announced.
    assertTrue(UpdateAlertRules.shouldNotify("0.6.9", 1, listOf("0.6.8", null, null), q, 3))
    // The version already running.
    assertFalse(UpdateAlertRules.shouldNotify("0.6.8", 1, listOf("0.6.8", null, null), q, 3))
    // Already downloaded by the app and waiting for a restart.
    assertFalse(UpdateAlertRules.shouldNotify("0.6.9", 1, listOf("0.6.8", "0.6.9", null), q, 3))
    // Already announced on an earlier run.
    assertFalse(UpdateAlertRules.shouldNotify("0.6.9", 1, listOf("0.6.8", null, "0.6.9"), q, 3))
    // A newer one after an announced one is news again.
    assertTrue(UpdateAlertRules.shouldNotify("0.6.10", 1, listOf("0.6.8", null, "0.6.9"), q, 3))
    // The registry going BACKWARDS (a bad publish rolled back) is never news.
    assertFalse(UpdateAlertRules.shouldNotify("0.6.7", 1, listOf("0.6.8", null, null), q, 3))
  }

  @Test
  fun blankFloorsAreNotFloors() {
    assertTrue(UpdateAlertRules.shouldNotify("0.6.9", 1, listOf(null, "", "  "), emptyList(), 0))
    assertFalse(UpdateAlertRules.shouldNotify("", 1, listOf(null, null, null), emptyList(), 0))
  }

  @Test
  fun neverAnnouncesWhatTheAppWouldRefuseToInstall() {
    assertFalse(UpdateAlertRules.shouldNotify("0.6.9", 1, listOf("0.6.8"), listOf("0.6.9"), 3))
    assertFalse(UpdateAlertRules.shouldNotify("0.6.9", 4, listOf("0.6.8"), emptyList(), 3))
    assertTrue(UpdateAlertRules.shouldNotify("0.6.9", 3, listOf("0.6.8"), emptyList(), 3))
    // An unreported generation does not gate - better one announcement too
    // many than silence from a binary that simply never heard from the page.
    assertTrue(UpdateAlertRules.shouldNotify("0.6.9", 4, listOf("0.6.8"), emptyList(), 0))
  }

  @Test
  fun bodyIsTheFirstTwoNotesWithoutTheirBullets() {
    val notes = "- Importing a playlist takes you straight to it.\n" +
      "- Songs that stopped arriving no longer spin.\n" +
      "- A third line nobody sees in the tray."
    assertEquals(
      "Importing a playlist takes you straight to it.\nSongs that stopped arriving no longer spin.",
      UpdateAlertRules.body(notes),
    )
    assertEquals("Only one.", UpdateAlertRules.body("  * Only one.\n\n"))
    assertNull(UpdateAlertRules.body(""))
    assertNull(UpdateAlertRules.body(null))
    assertNull(UpdateAlertRules.body("-\n - \n"))
  }
}
