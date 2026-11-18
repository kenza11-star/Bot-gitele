package app.absentmotion.library

import app.absentmotion.platform.Context
import app.absentmotion.platform.Uri
import app.absentmotion.model.mediaUris
import app.absentmotion.model.Layer
import app.absentmotion.model.Scene
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.util.UUID

data class SavedPreset(val id: String, val scene: Scene, val thumbnail: File? = null, val modified: Long = 0) {
    val title: String get() = scene.title
    val layer: Layer? get() = scene.layers.firstOrNull()
    val composition: Boolean get() = scene.node["aevixPreset"] == "composition"
}

class PresetStore(private val dir: File, private val open: (String) -> InputStream? = { uri ->
    URI(uri).takeIf { it.scheme == "file" }?.let { File(it).inputStream() }
}) {
    constructor(context: Context) : this(File(context.filesDir, "presets"), { uri -> context.applicationContext.contentResolver.openInputStream(Uri.parse(uri)) })

    fun list(): List<SavedPreset> = dir.listFiles { f -> f.extension == "xml" }.orEmpty().sortedByDescending { it.savedTime() }
        .mapNotNull { load(it.nameWithoutExtension) }

    fun load(id: String): SavedPreset? = runCatching {
        SavedPreset(id, Scene.parse(file(id).readText()), thumbnail(id).takeIf { it.isFile }, file(id).savedTime())
    }.getOrNull()?.takeIf { it.layer != null }

    fun save(scene: Scene): String {
        val id = UUID.randomUUID().toString()
        write(id, scene)
        return id
    }

    suspend fun addComposition(scene: Scene, render: suspend (Scene, Int, File) -> Boolean): SavedPreset = addComposition(scene, false, render)

    suspend fun addComposition(scene: Scene, requireMedia: Boolean, render: suspend (Scene, Int, File) -> Boolean): SavedPreset {
        require(scene.layers.isNotEmpty())
        val id = UUID.randomUUID().toString()
        try {
            val mediaDir = File(dir, "$id.media").canonicalFile.toPath()
            val stored = TemplateStore(dir, open).localize(scene, mediaDir.toFile())
                .let { Scene(it.node.with("aevixPreset", "composition")) }
            if (requireMedia && stored.node.mediaUris().any { uri ->
                    runCatching { File(URI(uri)).canonicalFile.toPath().startsWith(mediaDir) }.getOrDefault(false).not()
                }) throw IOException("The replacement media could not be copied. Choose the media again.")
            val picture = thumbnail(id)
            picture.parentFile?.mkdirs()
            if (!render(stored, presetPreviewTime(stored), picture) || !picture.isFile || picture.length() == 0L) {
                throw IOException("The preset preview could not be rendered")
            }
            currentCoroutineContext().ensureActive()
            write(id, stored)
            return load(id) ?: throw IOException("The saved preset could not be read")
        } catch (failure: Throwable) {
            delete(id)
            throw failure
        }
    }

    fun rename(id: String, title: String) {
        val preset = load(id) ?: throw java.io.IOException("Cannot read preset $id")
        write(id, preset.scene.withTitle(title))
    }

    fun delete(id: String) {
        file(id).delete()
        thumbnail(id).delete()
        File(dir, "$id.media").deleteRecursively()
    }

    fun deleteAll() {
        dir.listFiles { f -> f.extension == "xml" }.orEmpty().forEach { delete(it.nameWithoutExtension) }
    }

    private fun write(id: String, scene: Scene) = writeAtomically(file(id), scene.toXml())

    private fun file(id: String) = File(dir, "$id.xml")
    private fun thumbnail(id: String) = File(dir, "$id.png")
}

internal fun presetPreviewTime(scene: Scene): Int {
    val visible = scene.layers.filter { !it.hidden && it.kind != "audio" }
        .maxByOrNull { (it.endTime.toLong() - it.startTime).coerceAtLeast(0) } ?: return 0
    return ((visible.startTime.toLong() + visible.endTime) / 2).coerceIn(0, scene.totalTime.toLong().coerceAtLeast(0)).toInt()
}
