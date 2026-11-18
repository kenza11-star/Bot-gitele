package app.absentmotion.ui.home

import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.absentmotion.R
import app.absentmotion.engine.EngineThread
import app.absentmotion.library.AppSettings
import app.absentmotion.model.Scene
import app.absentmotion.library.ImportFailed
import app.absentmotion.library.PresetImport
import app.absentmotion.library.PresetImportResult
import app.absentmotion.library.PresetSource
import app.absentmotion.library.PresetSourceException
import app.absentmotion.library.PresetSourceProblem
import app.absentmotion.library.ProjectStore
import app.absentmotion.platform.ActivityResultContracts
import app.absentmotion.platform.LocalContext
import app.absentmotion.platform.PlatformFeatures
import app.absentmotion.platform.Uri
import app.absentmotion.platform.rememberLauncherForActivityResult
import app.absentmotion.ui.theme.Am
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream

@Composable
internal fun PresetImportScreen(
    paste: Boolean, projects: ProjectStore, engine: EngineThread, settings: AppSettings,
    onSaved: (PresetImportResult) -> Unit, onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val importer = remember(context, projects, engine) { PresetImport.forApp(context, projects, engine) }
    var draft by remember { mutableStateOf<PresetImport.Draft?>(null) }
    var index by remember { mutableStateOf(0) }
    var edited by remember { mutableStateOf<List<Scene>>(emptyList()) }
    DisposableEffect(draft) {
        val owned = draft
        onDispose { if (owned != null) CoroutineScope(Dispatchers.IO).launch { owned.discard() } }
    }
    var text by remember { mutableStateOf("") }
    var document by remember { mutableStateOf<Uri?>(null) }
    var running by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val view = LocalView.current
    @Suppress("DEPRECATION") val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    DisposableEffect(running) {
        val previous = view.keepScreenOn
        if (running) view.keepScreenOn = true
        onDispose { view.keepScreenOn = previous }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) { document = uri; problem = null }
    }
    fun run() {
        if (running) return
        running = true
        problem = null
        scope.launch {
            var downloaded: File? = null
            try {
                val job = currentCoroutineContext()
                val open: () -> InputStream? = if (paste) {
                    when (val source = PresetSource.parse(text)) {
                        is PresetSource.Xml -> ({ source.text.byteInputStream() })
                        is PresetSource.Download -> {
                            val file = withContext(Dispatchers.IO) {
                                source.download(File(context.cacheDir, "preset-import")) { job.ensureActive() }.also { downloaded = it }
                            }
                            ({ file.inputStream() })
                        }
                    }
                } else {
                    val uri = document ?: throw PresetSourceException(PresetSourceProblem.Empty)
                    ({ context.contentResolver.openInputStream(uri) })
                }
                draft = importer.prepare(open)
                index = 0
                edited = emptyList()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: PresetSourceException) {
                val message = when (failure.problem) {
                    PresetSourceProblem.Empty, PresetSourceProblem.Invalid -> R.string.preset_import_invalid
                    PresetSourceProblem.TooLarge -> R.string.preset_import_too_large
                    PresetSourceProblem.Insecure -> R.string.preset_import_insecure
                    PresetSourceProblem.NotDownload -> R.string.preset_import_link_download
                    PresetSourceProblem.DownloadTooLarge -> R.string.preset_import_download_large
                    PresetSourceProblem.Network -> R.string.preset_import_network
                }
                problem = context.getString(message)
            } catch (failure: ImportFailed) {
                problem = failure.text.resolve(context)
            } catch (_: OutOfMemoryError) {
                problem = context.getString(R.string.tools_too_big)
            } catch (failure: Exception) {
                problem = context.getString(R.string.preset_import_failed, failure.message.orEmpty())
            } finally {
                withContext(NonCancellable + Dispatchers.IO) { downloaded?.delete() }
                running = false
            }
        }
    }
    val prepared = draft
    if (prepared != null) {
        androidx.compose.ui.window.Dialog({}, androidx.compose.ui.window.DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false, usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
            app.absentmotion.platform.DialogStatusBarIcons(darkIcons = false)
            key(prepared.reports[index].id) {
                TemplateMediaEditor(
                    prepared.reports[index].id, prepared.scenes[index], engine, settings,
                    onClose = { if (!running) { draft = null; edited = emptyList() } },
                    onContinue = { scene ->
                        if (!running) {
                            val all = edited + scene
                            if (index < prepared.scenes.lastIndex) { edited = all; index++ }
                            else {
                                running = true
                                scope.launch {
                                    try {
                                        val result = prepared.save(all, requireMedia = true)
                                        currentCoroutineContext().ensureActive()
                                        onSaved(result)
                                    } catch (cancelled: CancellationException) { throw cancelled }
                                    catch (_: OutOfMemoryError) { draft = null; problem = context.getString(R.string.tools_too_big) }
                                    catch (failure: Exception) { draft = null; problem = context.getString(R.string.preset_import_failed, failure.message.orEmpty()) }
                                    finally { running = false }
                                }
                            }
                        }
                    },
                    requireMedia = true, savePreset = true, busy = running, step = index + 1, steps = prepared.scenes.size,
                )
            }
        }
        return
    }
    ToolSheet(
        title = stringResource(if (paste) R.string.tools_paste_preset else R.string.tools_upload_xml), onBack = onBack,
        bottom = {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                if (running) Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Am.Accent, strokeWidth = 2.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(R.string.preset_import_running), color = Am.Navy, fontSize = 14.sp)
                }
                problem?.let { Text(it, Modifier.padding(bottom = 12.dp), color = Am.Navy, fontSize = 14.sp) }
                if (running) Spacer(Modifier.height(12.dp))
                BigButton(stringResource(R.string.preset_import_run), Modifier.fillMaxWidth(),
                    enabled = !running && if (paste) text.isNotBlank() else document != null, onClick = ::run)
            }
        },
    ) {
        Spacer(Modifier.height(20.dp))
        Text(stringResource(R.string.preset_import_hint), color = Am.Navy, fontSize = 15.sp, lineHeight = 21.sp)
        Spacer(Modifier.height(20.dp))
        if (paste) {
            BigButton(stringResource(R.string.preset_import_clipboard), Modifier.fillMaxWidth(), primary = false, enabled = !running) {
                text = if (PlatformFeatures.desktop) clipboard.getText()?.text.orEmpty()
                    else context.getSystemService(ClipboardManager::class.java)?.primaryClip?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                problem = null
            }
            Spacer(Modifier.height(12.dp))
            BasicTextField(
                value = text, onValueChange = { text = it; problem = null }, enabled = !running,
                modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp, max = 300.dp)
                    .clip(RoundedCornerShape(8.dp)).background(Am.Card).padding(12.dp),
                textStyle = TextStyle(color = Am.Navy, fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                cursorBrush = SolidColor(Am.Accent), minLines = 6, maxLines = 12,
                decorationBox = { field ->
                    Box {
                        if (text.isEmpty()) Text(stringResource(R.string.preset_import_paste_hint), color = Am.HomeDim, fontSize = 13.sp)
                        field()
                    }
                },
            )
        } else {
            BigButton(stringResource(R.string.preset_import_choose_file), Modifier.fillMaxWidth(), HomeIcons.Upload, primary = false, enabled = !running) {
                picker.launch(arrayOf("text/xml", "application/xml", "application/zip", "application/octet-stream", "*/*"))
            }
            Text(document?.lastPathSegment ?: stringResource(R.string.preset_import_file_none),
                Modifier.padding(top = 12.dp), color = Am.Navy, fontSize = 14.sp)
        }
        Spacer(Modifier.height(20.dp))
        Text(stringResource(R.string.preset_import_formats), color = Am.HomeDim, fontSize = 14.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
internal fun PresetImportReportDialog(result: PresetImportResult, onDismiss: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.preset_import_done, result.presets.size), color = Am.Navy) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text(stringResource(R.string.preset_import_warning), color = Am.Navy)
                for (report in result.reports.filter { it.sections.isNotEmpty() }) {
                    Text(report.title, Modifier.padding(top = 16.dp), color = Am.Navy)
                    for ((heading, items) in report.sections) {
                        Text(heading.resolve(context), Modifier.padding(top = 8.dp), color = Am.Navy)
                        for (item in items) Text(item.resolve(context), color = Am.HomeDim, fontSize = 13.sp)
                    }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text(stringResource(R.string.ok), color = Am.Accent) } },
        containerColor = Am.Card,
    )
}
