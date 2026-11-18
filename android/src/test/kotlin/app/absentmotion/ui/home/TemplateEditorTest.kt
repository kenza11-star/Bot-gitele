package app.absentmotion.ui.home

import app.absentmotion.model.MediaDeclaration
import app.absentmotion.model.MediaFillMode
import app.absentmotion.model.PropRef
import app.absentmotion.model.Scene
import app.absentmotion.model.VideoTiming
import app.absentmotion.model.XmlNode
import app.absentmotion.model.keyframes
import app.absentmotion.model.mediaUris
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TemplateEditorTest {
    private fun media(uri: String, type: String, durationUs: Long = -1, orientation: Int = 0) =
        MediaDeclaration(XmlNode("media", linkedMapOf("uri" to uri, "type" to type, "duration" to "$durationUs", "width" to "100", "height" to "50", "orientation" to "$orientation")))

    private val template = Scene.parse(
        """<scene width="1080" height="1080" fps="30" totalTime="4000" title="T">
          <media uri="file:/a.jpg" type="image/jpeg" width="100" height="50" orientation="0"/>
          <media uri="file:/v.mp4" type="video/mp4" duration="4000000" width="100" height="50" orientation="0"/>
          <shape id="1" startTime="0" endTime="1999" fillType="media" fillImage="file:/a.jpg" mediaFillMode="fit" s=".rect"/>
          <shape id="2" startTime="0" endTime="3999" fillType="media" fillVideo="file:/v.mp4" inTime="1000" outTime="5000" mediaFillMode="fill" s=".rect"/>
          <embedScene id="3" startTime="0" endTime="3999"><scene width="1080" height="1080" fps="30">
            <shape id="4" startTime="500" endTime="1499" fillType="media" fillImage="file:/a.jpg" s=".rect"/>
          </scene></embedScene>
        </scene>""",
    )

    @Test fun slotsAreOnePerMediaFileWithTheLengthTheTemplatePlays() {
        val slots = slotsOf(template)
        assertEquals(listOf("file:/a.jpg", "file:/v.mp4"), slots.map { it.uri })
        assertEquals(listOf(1999, 3999), slots.map { it.length })
        assertEquals(listOf(false, true), slots.map { it.video })
    }

    @Test fun aPictureReplacesEveryLayerThatShowsTheOldOne() {
        val slots = slotsOf(template)
        val out = applied(template, slots, mapOf("file:/a.jpg" to Choice(media("content://new", "image/png"), 0, MediaFillMode.Fill)))
        val uris = out.node.mediaUris()
        assertTrue("file:/a.jpg" !in uris && "content://new" in uris && "file:/v.mp4" in uris)
        assertNull(out.media("file:/a.jpg"))
        assertEquals("image/png", out.media("content://new")!!.type)
        assertEquals("fill", out.layer(1)!!.node["mediaFillMode"])
        assertEquals("content://new", out.layer(3)!!.node.child("scene")!!.children.single()["fillImage"])
    }

    @Test fun aLongVideoStartsWhereTheUserDraggedIt() {
        val out = applied(template, slotsOf(template), mapOf("file:/v.mp4" to Choice(media("content://long", "video/mp4", 20_000_000), 2500, MediaFillMode.Fill)))
        val layer = out.layer(2)!!.node
        assertEquals("content://long", layer["fillVideo"])
        assertEquals("2500", layer["inTime"])
        assertEquals("6500", layer["outTime"])
    }

    @Test fun aShortVideoEndsWhereItDoesAndAPictureSlotCanTakeAVideo() {
        val short = media("content://short", "video/mp4", 1_000_000)
        val out = applied(template, slotsOf(template), mapOf("file:/v.mp4" to Choice(short, 0, MediaFillMode.Fill), "file:/a.jpg" to Choice(short, 0, MediaFillMode.Fit)))
        assertEquals("1000", out.layer(2)!!.node["outTime"])
        assertEquals("content://short", out.layer(1)!!.node["fillVideo"])
        assertNull(out.layer(1)!!.node["fillImage"])
        assertEquals("1000", out.layer(1)!!.node["outTime"])
    }

    @Test fun aSpeedRampMovesWithTheReplacementsStart() {
        val ramped = Scene.parse(
            """<scene width="1080" height="1080" fps="30" totalTime="1000">
              <media uri="file:/v.mp4" type="video/mp4" duration="4000000" width="100" height="50" orientation="0"/>
              <shape id="1" startTime="0" endTime="1000" fillType="media" fillVideo="file:/v.mp4" inTime="1000" outTime="3000" s=".rect">
                <speedMap><kf t="1000000000.000000" v="1"/><kf t="3000000000.000000" v="3"/></speedMap>
              </shape>
            </scene>""",
        )
        val out = applied(ramped, slotsOf(ramped), mapOf("file:/v.mp4" to Choice(media("content://long", "video/mp4", 20_000_000), 2500, MediaFillMode.Fill)))
        val before = ramped.layer(1)!!
        val after = out.layer(1)!!
        assertEquals("2500", after.node["inTime"])
        assertEquals(listOf(2_500_000_000f, 4_500_000_000f), after.node.child("speedMap")!!.keyframes.map { it.t })
        for (ms in listOf(0.0, 250.0, 500.0, 1000.0)) {
            assertEquals(VideoTiming(before).mediaMs(ms) - 1000, VideoTiming(after).mediaMs(ms) - 2500, 0.01)
        }
    }

    @Test fun aTurnedReplacementTurnsEveryRotationKeyframe() {
        val spinning = Scene.parse(
            """<scene width="1080" height="1080" fps="30" totalTime="1000">
              <media uri="file:/v.mp4" type="video/mp4" duration="1000000" width="100" height="50" orientation="0"/>
              <shape id="1" startTime="0" endTime="1000" fillType="media" fillVideo="file:/v.mp4" outTime="1000" s=".rect">
                <transform><rotation><kf t="0" v="0"/><kf t="1" v="360"/></rotation></transform>
                <property name="size" type="vec2" value="100,50"/>
              </shape>
            </scene>""",
        )
        val out = applied(spinning, slotsOf(spinning), mapOf("file:/v.mp4" to Choice(media("content://phone", "video/mp4", 1_000_000, 90), 0, MediaFillMode.Fill)))
        val layer = out.layer(1)!!
        assertEquals(listOf(90f, 450f), layer.keyframes(PropRef.Rotation).map { it.v.toFloat() })
        assertEquals(listOf(50f, 100f), layer.prop("size")!!.toList())
    }

    @Test fun aLoopingVideoKeepsLoopingWithItsReplacement() {
        val looped = Scene.parse(
            """<scene width="1080" height="1080" fps="30" totalTime="10000">
              <media uri="file:/v.mp4" type="video/mp4" duration="1000000" width="100" height="50" orientation="0"/>
              <shape id="1" startTime="0" endTime="10000" fillType="media" fillVideo="file:/v.mp4" outTime="1000" loop="true" s=".rect"/>
            </scene>""",
        )
        val slot = slotsOf(looped).single()
        assertEquals(1000, slot.length)
        assertTrue(slot.loop)
        val out = applied(looped, listOf(slot), mapOf("file:/v.mp4" to Choice(media("content://other", "video/mp4", 1_000_000), 0, MediaFillMode.Fill)))
        assertEquals("true", out.layer(1)!!.node["loop"])
        assertEquals("1000", out.layer(1)!!.node["outTime"])
        assertNull(applied(looped, listOf(slot), mapOf("file:/v.mp4" to Choice(media("content://photo", "image/png"), 0, MediaFillMode.Fill))).layer(1)!!.node["loop"])
    }

    @Test fun nothingChosenLeavesTheTemplateAsItWas() {
        assertEquals(template, applied(template, slotsOf(template), emptyMap()))
    }
    @Test fun nestedMissingMediaIsAReplaceableSlotAndLeavesNoStaleDeclaration() {
        val scene = Scene.parse("""<scene width="100" height="100" totalTime="3000"><embedScene id="1" startTime="1000" endTime="2999"><scene width="100" height="100"><media uri="blocked-file:/old.jpg" missing="true"/><shape id="2" startTime="200" endTime="1200" fillType="media" fillImage="blocked-file:/old.jpg"/></scene></embedScene></scene>""")
        val slot = slotsOf(scene).single()
        assertEquals(1200, slot.start)
        assertEquals(2200, slot.end)
        val out = applied(scene, listOf(slot), mapOf(slot.uri to Choice(media("content://new", "image/png"), 0, MediaFillMode.Fit)))
        assertTrue(slot.uri !in out.toXml())
        assertEquals(setOf("content://new"), out.node.mediaUris())
        val inner = out.layers.single().node.child("scene")!!
        assertEquals("200", inner.children.single()["startTime"])
        assertEquals("1200", inner.children.single()["endTime"])
    }

    @Test fun audioIsReplaceableAndKeepsGainEffectsAndTimelinePosition() {
        val scene = Scene.parse("""<scene width="100" height="100" totalTime="5000"><audio id="1" src="blocked-content://old/audio" startTime="1000" endTime="4000" inTime="500" outTime="3500" speed="1"><property name="gain" type="float" value="0.5"/><effect id="absent.equalizer"/></audio></scene>""")
        val slot = slotsOf(scene).single()
        assertTrue(slot.audio)
        assertEquals(3000, slot.length)
        val out = applied(scene, listOf(slot), mapOf(slot.uri to Choice(media("content://newaudio", "audio/mp4", 10_000_000), 0, MediaFillMode.Fill)))
        val layer = out.layers.single().node
        assertEquals("content://newaudio", layer["src"])
        assertEquals("1000", layer["startTime"])
        assertEquals("4000", layer["endTime"])
        assertEquals("3000", layer["outTime"])
        assertEquals("0.5", layer.child("property")!!["value"])
        assertEquals("absent.equalizer", layer.child("effect")!!["id"])
        assertNull(layer["fillImage"])
        assertNull(layer["fillVideo"])
    }

    @Test fun selectingAnotherOriginalMediaDoesNotChainTwoReplacements() {
        val out = applied(template, slotsOf(template), mapOf(
            "file:/a.jpg" to Choice(media("file:/v.mp4", "video/mp4", 4_000_000), 0, MediaFillMode.Fill),
            "file:/v.mp4" to Choice(media("content://other", "video/mp4", 4_000_000), 0, MediaFillMode.Fill),
        ))
        assertEquals("file:/v.mp4", out.layer(1)!!.node["fillVideo"])
        assertEquals("content://other", out.layer(2)!!.node["fillVideo"])
        assertEquals("file:/v.mp4", out.layer(3)!!.node.child("scene")!!.children.single()["fillVideo"])
    }

}
