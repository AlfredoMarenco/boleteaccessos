package com.boletea.accessos

import android.content.Intent
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.os.Bundle
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.math.BigInteger

class NfcReaderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    private var isDesiredActive: Boolean = false
    private var isReaderEnabled: Boolean = false

    private val readerCallback = NfcAdapter.ReaderCallback { tag ->
        handleTagDiscovered(tag)
    }

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String {
        return "NfcReader"
    }

    private fun computeStatus(): String {
        val adapter = NfcAdapter.getDefaultAdapter(reactContext) ?: return "unsupported"
        return if (adapter.isEnabled) "enabled" else "disabled"
    }

    private fun emitStatusChanged() {
        try {
            if (!reactContext.hasActiveReactInstance()) return
            val map = Arguments.createMap().apply {
                putString("status", computeStatus())
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("nfc_status_changed", map)
        } catch (_: Exception) {
        }
    }

    private fun enableInternal(): String {
        val adapter = NfcAdapter.getDefaultAdapter(reactContext) ?: return "unsupported"
        if (!adapter.isEnabled) {
            isReaderEnabled = false
            return "disabled"
        }

        val activity = reactContext.currentActivity ?: return "disabled"
        activity.runOnUiThread {
            try {
                val flags = NfcAdapter.FLAG_READER_NFC_A or
                    NfcAdapter.FLAG_READER_NFC_B or
                    NfcAdapter.FLAG_READER_NFC_F or
                    NfcAdapter.FLAG_READER_NFC_V or
                    NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS

                val options = Bundle().apply {
                    putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250)
                }

                adapter.enableReaderMode(activity, readerCallback, flags, options)
                isReaderEnabled = true
            } catch (_: Exception) {
                isReaderEnabled = false
            }
        }
        return "enabled"
    }

    private fun disableInternal() {
        val adapter = NfcAdapter.getDefaultAdapter(reactContext) ?: return
        val activity = reactContext.currentActivity ?: return
        activity.runOnUiThread {
            try {
                if (isReaderEnabled) {
                    adapter.disableReaderMode(activity)
                }
            } catch (_: Exception) {
            } finally {
                isReaderEnabled = false
            }
        }
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        try {
            promise.resolve(computeStatus())
        } catch (e: Exception) {
            promise.resolve("unsupported")
        }
    }

    @ReactMethod
    fun startReader(promise: Promise) {
        try {
            isDesiredActive = true
            val status = enableInternal()
            promise.resolve(status)
        } catch (e: Exception) {
            promise.reject("NFC_START_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopReader(promise: Promise) {
        try {
            isDesiredActive = false
            disableInternal()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openNfcSettings() {
        try {
            val intent = Intent(Settings.ACTION_NFC_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
        } catch (_: Exception) {
            try {
                val fallback = Intent(Settings.ACTION_WIRELESS_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(fallback)
            } catch (_: Exception) {
            }
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN NativeEventEmitter compatibility
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN NativeEventEmitter compatibility
    }

    private fun handleTagDiscovered(tag: Tag?) {
        if (tag == null) return

        val idBytes = tag.id ?: ByteArray(0)
        val uidHex = idBytes.joinToString("") { "%02X".format(it) }
        val uidColon = idBytes.joinToString(":") { "%02X".format(it) }
        val reversedBytes = idBytes.reversedArray()
        val uidReversedHex = reversedBytes.joinToString("") { "%02X".format(it) }
        val uidDecBe = if (idBytes.isNotEmpty()) BigInteger(1, idBytes).toString(10) else ""
        val uidDecLe = if (reversedBytes.isNotEmpty()) BigInteger(1, reversedBytes).toString(10) else ""

        var ndefText: String? = null
        try {
            val ndef = Ndef.get(tag)
            if (ndef != null) {
                var message: NdefMessage? = ndef.cachedNdefMessage
                if (message == null) {
                    try {
                        ndef.connect()
                        message = ndef.ndefMessage
                    } catch (_: Exception) {
                    } finally {
                        try {
                            ndef.close()
                        } catch (_: Exception) {
                        }
                    }
                }
                if (message != null) {
                    ndefText = extractPayloadFromNdef(message)
                }
            }
        } catch (_: Exception) {
        }

        val cleanNdef = ndefText?.trim()?.takeIf { it.isNotEmpty() }
        val primaryCode = cleanNdef ?: uidHex
        if (primaryCode.isEmpty()) return

        val rawCandidates = LinkedHashSet<String>()
        rawCandidates.add(primaryCode)
        if (uidHex.isNotEmpty()) rawCandidates.add(uidHex)
        if (uidReversedHex.isNotEmpty()) rawCandidates.add(uidReversedHex)
        if (uidColon.isNotEmpty()) rawCandidates.add(uidColon)
        if (uidDecLe.isNotEmpty()) {
            rawCandidates.add(uidDecLe)
            if (idBytes.size == 4 && uidDecLe.length < 10) {
                rawCandidates.add(uidDecLe.padStart(10, '0'))
            }
        }
        if (uidDecBe.isNotEmpty()) {
            rawCandidates.add(uidDecBe)
            if (idBytes.size == 4 && uidDecBe.length < 10) {
                rawCandidates.add(uidDecBe.padStart(10, '0'))
            }
        }

        val candidatesArray = Arguments.createArray()
        rawCandidates.take(8).forEach { candidate ->
            candidatesArray.pushString(candidate)
        }

        val payload = Arguments.createMap().apply {
            putString("code", primaryCode)
            putString("uid", uidHex)
            putString("format", if (cleanNdef != null) "ndef" else "uid")
            putArray("candidates", candidatesArray)
        }

        try {
            if (reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("nfc_tag_scanned", payload)
            }
        } catch (_: Exception) {
        }
    }

    private fun extractPayloadFromNdef(message: NdefMessage): String? {
        for (record in message.records) {
            val payload = record.payload ?: continue
            if (payload.isEmpty()) continue

            try {
                if (record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_TEXT)) {
                    val status = payload[0].toInt()
                    val isUtf16 = (status and 0x80) != 0
                    val langLen = status and 0x3F
                    if (payload.size > 1 + langLen) {
                        val charset = if (isUtf16) Charsets.UTF_16 else Charsets.UTF_8
                        val text = String(payload, 1 + langLen, payload.size - 1 - langLen, charset).trim()
                        if (text.isNotEmpty()) return text
                    }
                } else if (record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_URI)) {
                    val uri = record.toUri()?.toString()?.trim()
                    if (!uri.isNullOrEmpty()) return uri
                } else if (record.tnf == NdefRecord.TNF_MIME_MEDIA || record.tnf == NdefRecord.TNF_EXTERNAL_TYPE) {
                    val text = String(payload, Charsets.UTF_8).trim()
                    if (text.isNotEmpty()) return text
                }
            } catch (_: Exception) {
            }
        }
        return null
    }

    override fun onHostResume() {
        emitStatusChanged()
        if (isDesiredActive) {
            enableInternal()
        }
    }

    override fun onHostPause() {
        disableInternal()
    }

    override fun onHostDestroy() {
        isDesiredActive = false
        disableInternal()
    }
}
