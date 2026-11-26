package com.nomoat.voiceinput.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.nomoat.voiceinput.DictationStatus
import com.nomoat.voiceinput.FileVoiceStore
import com.nomoat.voiceinput.OkHttpVoiceSocket
import com.nomoat.voiceinput.StoredDictation
import com.nomoat.voiceinput.VoiceMode
import com.nomoat.voiceinput.VoiceSession
import com.nomoat.voiceinput.VoiceSessionOptions
import com.nomoat.voiceinput.VoiceSocketFactory
import com.nomoat.voiceinput.VoiceStore
import com.nomoat.voiceinput.listDictations
import com.nomoat.voiceinput.markDiscarded
import com.nomoat.voiceinput.markInserted
import kotlin.math.roundToLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

suspend fun recoverableDictations(store: VoiceStore, target: String, exclude: String? = null): List<StoredDictation> =
    listDictations(store, target).filter {
        it.session != exclude &&
            (it.status == DictationStatus.Unfinished || it.status == DictationStatus.Complete) &&
            (it.text.isNotEmpty() || it.durationMs > 0)
    }

fun dictationMinutes(ms: Long): String = "${maxOf(1L, (ms / 60_000.0).roundToLong())} min"

@Composable
fun VoiceRecoveryBanner(
    target: String,
    url: String,
    onText: suspend (String, VoiceTextInfo) -> Unit,
    modifier: Modifier = Modifier,
    token: (suspend () -> String?)? = null,
    store: VoiceStore? = null,
    socket: VoiceSocketFactory? = null,
    strings: VoiceStrings = englishVoiceStrings,
    colors: VoicePanelColors = VoicePanelDefaults.colors(),
    exclude: String? = null,
    refreshKey: Any? = null,
) {
    val context = LocalContext.current.applicationContext
    val actualStore = store ?: remember(context) { FileVoiceStore.shared(context) }
    val scope = rememberCoroutineScope()
    var items by remember(target, actualStore) { mutableStateOf(emptyList<StoredDictation>()) }
    var busy by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    val latestText by rememberUpdatedState(onText)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refresh++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(target, actualStore, exclude, refreshKey, refresh) {
        items = try {
            recoverableDictations(actualStore, target, exclude)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }
    val item = items.firstOrNull() ?: return

    fun restore() {
        if (busy != null) return
        busy = item.session
        scope.launch {
            try {
                var text = item.tidy ?: item.text
                if (item.status == DictationStatus.Unfinished) {
                    val session = VoiceSession.restore(
                        item.session,
                        VoiceSessionOptions(url = url, store = actualStore, token = token, socket = socket ?: OkHttpVoiceSocket.Factory()),
                    )
                    val result = try {
                        session?.result?.await()
                    } catch (e: CancellationException) {
                        session?.abandon()
                        throw e
                    } ?: return@launch
                    text = result.text
                }
                withContext(NonCancellable) {
                    if (text.isNotEmpty()) {
                        latestText(
                            text,
                            VoiceTextInfo(
                                raw = item.text.ifEmpty { text },
                                tidied = item.tidy != null,
                                session = item.session,
                                mode = VoiceMode.Restore,
                            ),
                        )
                    }
                    markInserted(actualStore, item.session)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            } finally {
                busy = null
                refresh++
            }
        }
    }

    fun discard() {
        if (busy != null) return
        scope.launch {
            try {
                markDiscarded(actualStore, item.session)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            refresh++
        }
    }

    val preview = if (item.text.length > 80) item.text.take(80) + "…" else item.text
    Row(
        modifier
            .fillMaxWidth()
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
            Text(strings.unfinished(dictationMinutes(item.durationMs)), color = colors.content, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            if (preview.isNotEmpty()) Text(preview, color = colors.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = ::restore, enabled = busy == null) {
            Text(if (busy != null) strings.finishing else if (item.status == DictationStatus.Complete) strings.insert else strings.restore, fontSize = 13.sp)
        }
        TextButton(onClick = ::discard, enabled = busy == null) { Text(strings.discard, fontSize = 13.sp) }
    }
}
