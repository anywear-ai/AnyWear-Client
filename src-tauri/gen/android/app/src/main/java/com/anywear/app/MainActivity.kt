package com.anywear.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Android 15+ forces edge-to-edge for targetSdk 35+, and WebView's support for
    // CSS `env(safe-area-inset-*)` depends on the Chromium version an OEM ships.
    // The shell therefore consumes the window insets itself, once, on the content
    // view that holds the WebView: system bars, display cutout and the IME are
    // taken as the per-edge maximum, so a notch, a gesture bar or an open keyboard
    // never overlaps the shared UI and the CSS needs no duplicate padding.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val safeArea = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime()
      )
      view.updatePadding(
        left = safeArea.left,
        top = safeArea.top,
        right = safeArea.right,
        bottom = safeArea.bottom
      )
      insets
    }
  }
}
