package app.absentmotion.library

import app.absentmotion.R
import app.absentmotion.engine.EngineThread
import app.absentmotion.i18n.txt
import app.absentmotion.model.Scene
import app.absentmotion.model.storedMediaUris
import app.absentmotion.platform.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream

data class PresetImportResult(val presets: List<SavedPreset>, val reports: List<ImportReport>)

class PresetImport(
    private val projects: ProjectStore,
    private val presets: PresetStore,
    private val importer: Importer,
    private val render: suspend (Scene, Int, File) -> Boolean,
) {
    /** Keep package assets alive while the user replaces the composition's media. */
    suspend fun prepare(open: () -> InputStream?): Draft {
        val reports = ArrayList<ImportReport>()
        var delivered = false
        try {
            val draft = withContext(Dispatchers.IO) {
                val job = currentCoroutineContext()
                reports += importer.import {
                    open()?.let { input -> object : FilterInputStream(input) {
                        override fun read(): Int { job.ensureActive(); return super.read() }
                        override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
                            job.ensureActive()
                            return super.read(bytes, offset, count)
                        }
                    } }
                }
                val scenes = reports.map { report ->
                    job.ensureActive()
                    val scene = projects.load(report.id) ?: throw IOException("The imported scene could not be read")
                    if (scene.layers.isEmpty()) throw ImportFailed(txt(R.string.preset_import_empty_scene))
                    scene
                }
                Draft(reports.toList(), scenes)
            }
            delivered = true
            return draft
        } finally {
            if (!delivered) withContext(NonCancellable + Dispatchers.IO) { reports.forEach { projects.delete(it.id) } }
        }
    }

    suspend fun import(open: () -> InputStream?): PresetImportResult = prepare(open).save()

    inner class Draft internal constructor(val reports: List<ImportReport>, val scenes: List<Scene>) {
        private val mutex = kotlinx.coroutines.sync.Mutex()
        private var closed = false

        suspend fun discard() = withContext(NonCancellable + Dispatchers.IO) {
            mutex.lock()
            try { close() } finally { mutex.unlock() }
        }

        private fun close() {
            if (!closed) {
                reports.forEach { projects.delete(it.id) }
                closed = true
            }
        }

        /** Publish only after every composition is edited; failed batches are rolled back. */
        suspend fun save(edited: List<Scene> = scenes, requireMedia: Boolean = false): PresetImportResult {
            val saved = ArrayList<SavedPreset>()
            var complete = false
            mutex.lock()
            try {
                check(!closed) { "Preset import has already finished" }
                require(edited.size == scenes.size)
                val result = withContext(Dispatchers.IO) {
                    for (scene in edited) {
                        currentCoroutineContext().ensureActive()
                        if (requireMedia && importer.missingMedia(scene).isNotEmpty()) throw IOException("Media is no longer available. Choose the replacement again.")
                        val preset = presets.addComposition(scene, requireMedia, render)
                        saved += preset
                        if (preset.scene.node.storedMediaUris().any(projects::inMediaFolder) ||
                            requireMedia && importer.missingMedia(preset.scene).isNotEmpty()) {
                            throw IOException("Preset media could not be copied")
                        }
                    }
                    PresetImportResult(saved.toList(), reports.mapIndexed { index, report ->
                        importer.refreshMediaReport(report, saved[index].scene).copy(id = saved[index].id)
                    })
                }
                complete = true
                return result
            } finally {
                try {
                    withContext(NonCancellable + Dispatchers.IO) {
                        if (!complete) saved.forEach { presets.delete(it.id) }
                        close()
                    }
                } finally { mutex.unlock() }
            }
        }
    }

    companion object {
        fun forApp(context: Context, projects: ProjectStore, engine: EngineThread): PresetImport =
            PresetImport(projects, PresetStore(context), Importer.forApp(context, projects)) { scene, time, file ->
                val side = maxOf(scene.width, scene.height, 1)
                engine.stillPng(scene.toXml(), time, (256L * scene.width / side).toInt().coerceAtLeast(1),
                    (256L * scene.height / side).toInt().coerceAtLeast(1), file)
            }
    }
}
