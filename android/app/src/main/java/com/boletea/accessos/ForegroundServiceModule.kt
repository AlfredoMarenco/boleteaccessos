package com.boletea.accessos

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ForegroundServiceModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "ForegroundService"
    }

    @ReactMethod
    fun startService(message: String) {
        val serviceIntent = Intent(reactContext, ForegroundService::class.java)
        serviceIntent.putExtra("inputExtra", message)
        ContextCompat.startForegroundService(reactContext, serviceIntent)
    }

    @ReactMethod
    fun stopService() {
        val serviceIntent = Intent(reactContext, ForegroundService::class.java)
        reactContext.stopService(serviceIntent)
    }
}
