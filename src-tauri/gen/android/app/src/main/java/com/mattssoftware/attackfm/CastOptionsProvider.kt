package com.mattssoftware.attackfm

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider

/**
 * What the Cast framework reads before it will exist at all.
 *
 * Named in the manifest (OPTIONS_PROVIDER_CLASS_NAME) and instantiated by the
 * framework, never by us. The receiver is Google's DEFAULT media receiver:
 * the app streams ordinary audio files over https, which is exactly what that
 * receiver plays, and a custom receiver would mean a registered app id and a
 * hosted page for no capability this app needs.
 */
class CastOptionsProvider : OptionsProvider {
  override fun getCastOptions(context: Context): CastOptions =
    CastOptions.Builder()
      .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
      // Ending the session stops the receiver too. The phone is the brain of
      // this arrangement - it advances the queue and feeds the next URL - so
      // a TV left playing after a deliberate disconnect would finish one song
      // and sit there; better that "stop casting" means stop.
      .setStopReceiverApplicationWhenEndingSession(true)
      .build()

  override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
