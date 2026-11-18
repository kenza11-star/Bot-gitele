package app.absentmotion.library

import app.absentmotion.model.Scene
import app.absentmotion.model.mediaUris
import app.absentmotion.compat.EffectMigration
import app.absentmotion.effects.EffectCatalog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class PresetImportTest {
    @get:Rule val tmp = TemporaryFolder()

    private val xml = """<scene title="Imported motion" width="720" height="1280" fps="24" totalTime="2000" am="com.alightcreative.motion/5">
        <shape id="1" label="First" startTime="0" endTime="1999" s=".rect"><transform><location><kf t="0" v="10,20,0"/><kf t="1" v="100,200,0"/></location></transform></shape>
        <text id="2" label="Second" startTime="500" endTime="1999" size="32">Hello</text>
        </scene>"""

    private fun service(projects: ProjectStore, presets: PresetStore, render: suspend (Scene, Int, File) -> Boolean = { _, _, file ->
        file.parentFile!!.mkdirs()
        file.writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        true
    }) = PresetImport(projects, presets, Importer(projects), render)

    @Test fun completeCompositionAndKeyframesAreSavedAndStagingProjectsAreRemoved() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val result = service(projects, presets).import { ByteArrayInputStream(xml.toByteArray()) }
        val saved = presets.load(result.presets.single().id)!!
        assertTrue(saved.composition)
        assertEquals(listOf("First", "Second"), saved.scene.layers.map { it.label })
        assertEquals(24, saved.scene.fps)
        assertEquals(2000, saved.scene.totalTime)
        assertEquals("100,200,0", saved.scene.layers[0].node.child("transform")!!.child("location")!!.children[1]["v"])
        assertTrue(saved.thumbnail!!.isFile)
        assertTrue(projects.list().isEmpty())
        presets.rename(saved.id, "Renamed")
        assertEquals("Renamed", presets.load(saved.id)!!.title)
    }

    @Test fun rendererFailureDoesNotPublishAPresetOrLeaveAProject() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        try {
            service(projects, presets) { _, _, _ -> false }.import { ByteArrayInputStream(xml.toByteArray()) }
            fail("A failed render was published")
        } catch (_: IOException) {
            assertTrue(presets.list().isEmpty())
            assertTrue(projects.list().isEmpty())
        }
    }

    @Test fun cancellationRollsBackFiles() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val folder = tmp.newFolder()
        val presets = PresetStore(folder)
        try {
            service(projects, presets) { _, _, _ -> throw CancellationException("cancel") }.import { ByteArrayInputStream(xml.toByteArray()) }
            fail("Cancellation was swallowed")
        } catch (_: CancellationException) {
            assertTrue(presets.list().isEmpty())
            assertTrue(projects.list().isEmpty())
            assertTrue(folder.listFiles().orEmpty().isEmpty())
        }
    }

    @Test fun packagedMediaBelongsToThePresetAfterTemporaryProjectsAreDeleted() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val scene = """<scene title="Media" width="100" height="100" fps="30" totalTime="999"><media uri="amproj:a.png" filename="a.png"/><shape id="1" startTime="0" endTime="999" fillType="media" fillImage="amproj:a.png"/></scene>"""
        val manifest = """{"format":"absentmotion-package","version":1,"media":[{"uri":"amproj:a.png","entry":"media/a.png"}]}"""
        val bytes = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { zip ->
            for ((name, data) in listOf("project.xml" to scene, "manifest.json" to manifest, "media/a.png" to "image bytes")) {
                zip.putNextEntry(ZipEntry(name)); zip.write(data.toByteArray()); zip.closeEntry()
            }
        } }.toByteArray()
        val draft = service(projects, presets).prepare { ByteArrayInputStream(bytes) }
        val staged = File(URI(draft.scenes.single().node.mediaUris().single()))
        assertEquals("image bytes", staged.readText())
        assertTrue(presets.list().isEmpty())
        val result = draft.save(requireMedia = true)
        assertFalse(staged.exists())
        val saved = presets.load(result.presets.single().id)!!
        val uris = saved.scene.node.mediaUris().toList()
        assertTrue(uris.isNotEmpty())
        assertFalse(uris.any(projects::inMediaFolder))
        val media = File(URI(uris.first()))
        assertEquals("image bytes", media.readText())
        presets.delete(saved.id)
        assertFalse(media.exists())
        assertTrue(projects.list().isEmpty())
    }

    @Test fun emptySceneCannotBecomeAnInvisiblePreset() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        try {
            service(projects, presets).import { ByteArrayInputStream("<scene width=\"100\" height=\"100\"/>".toByteArray()) }
            fail("Saved an empty preset")
        } catch (_: ImportFailed) {
            assertTrue(presets.list().isEmpty())
            assertTrue(projects.list().isEmpty())
        }
    }

    @Test fun previewUsesAVisibleLayerTimeInsteadOfAnEmptyGap() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val scene = """<scene width="100" height="100" fps="30" totalTime="8000"><shape id="1" hidden="true" startTime="0" endTime="7999"/><shape id="2" startTime="6000" endTime="7999"/></scene>"""
        var renderedAt = -1
        service(projects, presets) { _, time, file -> renderedAt = time; file.writeText("preview"); true }
            .import { ByteArrayInputStream(scene.toByteArray()) }
        assertEquals(6999, renderedAt)
    }

    @Test fun alightEffectsAreConvertedBeforeTheRendererReceivesTheScene() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val pack = File("../shared/assets/effects")
        val catalog = EffectCatalog.parse { pack.resolve(it).inputStream() }
        val migration = EffectMigration.parse(pack.resolve("foreign.json").readText(), catalog)
        val input = """<scene title="Alight" width="100" height="100" fps="30" totalTime="999" am="com.alightcreative.motion/5"><shape id="1" startTime="0" endTime="999"><effect id="com.alightcreative.effects.mirror"><property name="type" type="int" value="1"/></effect></shape></scene>"""
        var renderedId: String? = null
        val importer = PresetImport(projects, presets, Importer(projects, migration = migration, canRun = { catalog.find(it) != null })) { scene, _, file ->
            renderedId = scene.layers.single().node.child("effect")?.get("id")
            file.writeText("preview")
            true
        }
        val result = importer.import { ByteArrayInputStream(input.toByteArray()) }
        assertEquals("absent.mirror", renderedId)
        assertEquals("absent.mirror", result.presets.single().scene.layers.single().node.child("effect")!!["id"])
    }

    @Test fun unknownEffectsAreKeptWithACompatibilityReport() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val input = """<scene width="100" height="100" fps="30" totalTime="999"><shape id="1" startTime="0" endTime="999"><effect id="com.alightcreative.effects.unknownfutureeffect"/></shape></scene>"""
        val importer = PresetImport(projects, presets, Importer(projects, canRun = { false })) { _, _, file -> file.writeText("preview"); true }
        val result = importer.import { ByteArrayInputStream(input.toByteArray()) }
        assertEquals("com.alightcreative.effects.unknownfutureeffect", result.presets.single().scene.layers.single().node.child("effect")!!["id"])
        assertTrue(result.reports.single().sections.isNotEmpty())
    }
    @Test fun preparationDoesNotRenderOrPublishAndDiscardIsIdempotent() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        var renders = 0
        val draft = service(projects, presets) { _, _, file -> renders++; file.writeText("preview"); true }
            .prepare { xml.byteInputStream() }
        assertEquals(1, draft.scenes.size)
        assertEquals(0, renders)
        assertTrue(presets.list().isEmpty())
        assertEquals(1, projects.list().size)
        draft.discard()
        draft.discard()
        assertTrue(projects.list().isEmpty())
        assertTrue(presets.list().isEmpty())
    }

    @Test fun replacingMissingMediaBeforeSaveUpdatesTheReportAndKeepsAnimations() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val selected = tmp.newFile("selected.jpg").also { it.writeText("my photo") }
        val input = """<scene width="100" height="100" fps="30" totalTime="2000"><media uri="missing:old.jpg" missing="true"/>
            <shape id="1" startTime="500" endTime="1999" fillType="media" fillImage="missing:old.jpg"><transform><location><kf t="0" v="0,0,0"/><kf t="1" v="10,20,0"/></location></transform></shape></scene>"""
        val importer = PresetImport(projects, presets, Importer(projects, exists = { uri ->
            runCatching { File(URI(uri)).isFile }.getOrDefault(false)
        })) { _, _, file -> file.writeText("preview"); true }
        val draft = importer.prepare { input.byteInputStream() }
        assertTrue(draft.reports.single().sections.isNotEmpty())
        val chosen = app.absentmotion.model.MediaDeclaration(app.absentmotion.model.XmlNode("media", mapOf("uri" to selected.toURI().toString(), "type" to "image/jpeg")))
        val working = app.absentmotion.ui.home.applied(draft.scenes.single(), app.absentmotion.ui.home.slotsOf(draft.scenes.single()),
            mapOf("missing:old.jpg" to app.absentmotion.ui.home.Choice(chosen, 0, app.absentmotion.model.MediaFillMode.Fill)))
        val result = draft.save(listOf(working), requireMedia = true)
        assertTrue(result.reports.single().sections.isEmpty())
        val saved = result.presets.single().scene
        assertEquals("500", saved.layers.single().node["startTime"])
        assertEquals("10,20,0", saved.layers.single().node.child("transform")!!.child("location")!!.children.last()["v"])
        val copied = File(URI(saved.node.mediaUris().single()))
        selected.delete()
        assertEquals("my photo", copied.readText())
        assertTrue(projects.list().isEmpty())
    }

    @Test fun requiredMediaCannotBeSavedIfTheChosenFileWasRemoved() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val input = """<scene width="100" height="100" fps="30" totalTime="1000"><shape id="1" startTime="0" endTime="999" fillType="media" fillImage="file:/gone.jpg"/></scene>"""
        val draft = service(projects, presets).prepare { input.byteInputStream() }
        try {
            draft.save(requireMedia = true)
            fail("Published a preset without copying its required media")
        } catch (_: IOException) {
            assertTrue(projects.list().isEmpty())
            assertTrue(presets.list().isEmpty())
        }
    }

    @Test fun cancelAfterPrepareDoesNotRemoveThePreviousPreset() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val service = service(projects, presets)
        val previous = service.import { xml.byteInputStream() }.presets.single()
        val draft = service.prepare { xml.byteInputStream() }
        draft.discard()
        assertEquals(listOf(previous.id), presets.list().map { it.id })
        assertTrue(projects.list().isEmpty())
    }

    @Test fun failedSecondCompositionRollsBackTheWholeEditedBatch() = runBlocking {
        val projects = ProjectStore(tmp.newFolder())
        val presets = PresetStore(tmp.newFolder())
        val bytes = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { zip ->
            for ((name, data) in listOf("one.xml" to xml, "two.xml" to xml, "manifest.json" to """{"format":"absentmotion-package","version":1,"media":[]}""")) {
                zip.putNextEntry(ZipEntry(name)); zip.write(data.toByteArray()); zip.closeEntry()
            }
        } }.toByteArray()
        var renders = 0
        val draft = service(projects, presets) { _, _, file -> renders++; file.writeText("preview"); renders < 2 }
            .prepare { bytes.inputStream() }
        assertEquals(2, draft.scenes.size)
        assertEquals(0, renders)
        try {
            draft.save(requireMedia = true)
            fail("Published a partially rendered batch")
        } catch (_: IOException) {
            assertEquals(2, renders)
            assertTrue(presets.list().isEmpty())
            assertTrue(projects.list().isEmpty())
        }
    }

}
