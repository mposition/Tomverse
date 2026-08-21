/**
 * The trusted PPTX writer.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3 and 6.
 *
 * PresentationML is the strictest of the three OOXML formats this application
 * writes. A slide is not standalone: it must point at a layout, the layout must
 * point at a master, the master must carry a full theme, and PowerPoint refuses
 * the package if any link in that chain is missing. So all four are written
 * here, from constants, and a slide can only reference what this file defines.
 *
 * What the package deliberately does not contain, because nothing here writes
 * the part: `ppt/vbaProject.bin` (the package is `.pptx`, never `.pptm`),
 * hyperlink relationships, external media, and OLE objects. A deck produced
 * from a specification has no links, because the specification has no link.
 *
 * Speaker notes are written to `notesSlide` parts rather than onto the slide.
 * They are what a presenter reads, and a model that puts them on the slide has
 * produced a different deck from the one that was asked for.
 */

import {
  type ArtifactSlideSpec,
  type PresentationSpec,
} from "@/lib/generatedArtifactCore";
import {
  CORE_PROPERTIES_OVERRIDE,
  CORE_PROPERTIES_PART,
  CORE_PROPERTIES_RELATIONSHIP,
  RELATIONSHIPS_OPEN,
  XML_DECLARATION,
  escapeXml,
  relationship,
  zipOoxmlPackage,
  type OoxmlPart,
} from "@/lib/generatedArtifactXml";

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R_NS =
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** EMU: DrawingML's unit, 914400 per inch. A 16:9 slide at 13.333 x 7.5 inch. */
const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const MARGIN_X = 838200;

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * The fonts every text run names.
 *
 * `ea` is the East Asian face, which is the one that decides whether a Korean
 * bullet renders as text or as boxes. Named rather than embedded, like the
 * DOCX writer and for the same reason: PowerPoint has a font book.
 */
const FONT_REFERENCE =
  `<a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface="Calibri"/>`;

const textRuns = (value: string, size: number, bold: boolean): string => {
  const properties =
    `<a:rPr lang="en-US" altLang="ko-KR" sz="${size}"${bold ? ' b="1"' : ""} dirty="0">` +
    `${FONT_REFERENCE}</a:rPr>`;
  return value
    .split(/\r\n|\r|\n/)
    .map(
      (line, index) =>
        (index > 0 ? `<a:br>${properties}</a:br>` : "") +
        `<a:r>${properties}<a:t>${escapeXml(line)}</a:t></a:r>`
    )
    .join("");
};

const shape = (input: {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paragraphs: string;
  anchor?: "t" | "ctr";
}) =>
  `<p:sp><p:nvSpPr>` +
  `<p:cNvPr id="${input.id}" name="${escapeXml(input.name)}"/>` +
  `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${input.x}" y="${input.y}"/>` +
  `<a:ext cx="${input.width}" cy="${input.height}"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `<p:txBody><a:bodyPr wrap="square" anchor="${input.anchor ?? "t"}"><a:normAutofit/></a:bodyPr>` +
  `<a:lstStyle/>${input.paragraphs}</p:txBody></p:sp>`;

const bulletParagraph = (value: string) =>
  `<a:p><a:pPr marL="285750" indent="-285750"><a:buChar char="•"/></a:pPr>` +
  `${textRuns(value, 1800, false)}</a:p>`;

const plainParagraph = (value: string, size: number, bold: boolean) =>
  `<a:p><a:pPr><a:buNone/></a:pPr>${textRuns(value, size, bold)}</a:p>`;

const slideXml = (slide: ArtifactSlideSpec): string => {
  const width = SLIDE_WIDTH - MARGIN_X * 2;
  const shapes: string[] = [];

  if (slide.layout === "title") {
    shapes.push(
      shape({
        id: 2,
        name: "Title",
        x: MARGIN_X,
        y: 2000000,
        width,
        height: 1600000,
        paragraphs: plainParagraph(slide.title, 4400, true),
        anchor: "ctr",
      })
    );
    if (slide.subtitle) {
      shapes.push(
        shape({
          id: 3,
          name: "Subtitle",
          x: MARGIN_X,
          y: 3700000,
          width,
          height: 900000,
          paragraphs: plainParagraph(slide.subtitle, 2000, false),
        })
      );
    }
  } else if (slide.layout === "sectionHeader") {
    shapes.push(
      shape({
        id: 2,
        name: "Section",
        x: MARGIN_X,
        y: 2600000,
        width,
        height: 1200000,
        paragraphs: plainParagraph(slide.title, 3600, true),
        anchor: "ctr",
      })
    );
    if (slide.subtitle) {
      shapes.push(
        shape({
          id: 3,
          name: "Section subtitle",
          x: MARGIN_X,
          y: 3800000,
          width,
          height: 700000,
          paragraphs: plainParagraph(slide.subtitle, 1800, false),
        })
      );
    }
  } else {
    shapes.push(
      shape({
        id: 2,
        name: "Title",
        x: MARGIN_X,
        y: 533400,
        width,
        height: 1100000,
        paragraphs: plainParagraph(slide.title, 3200, true),
      })
    );
    const body: string[] = [];
    if (slide.subtitle) body.push(plainParagraph(slide.subtitle, 2000, false));
    for (const bullet of slide.bullets ?? []) body.push(bulletParagraph(bullet));
    if (body.length > 0) {
      shapes.push(
        shape({
          id: 3,
          name: "Content",
          x: MARGIN_X,
          y: 1800000,
          width,
          height: SLIDE_HEIGHT - 1800000 - 533400,
          paragraphs: body.join(""),
        })
      );
    }
  }

  return (
    `${XML_DECLARATION}` +
    `<p:sld ${A_NS} ${P_NS} ${R_NS}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
};

const notesSlideXml = (notes: string): string =>
  `${XML_DECLARATION}` +
  `<p:notes ${A_NS} ${P_NS} ${R_NS}><p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  shape({
    id: 2,
    name: "Notes Placeholder",
    x: 0,
    y: 0,
    width: 6858000,
    height: 4114800,
    paragraphs: plainParagraph(notes, 1200, false),
  }) +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;

/**
 * A minimal but complete theme.
 *
 * PowerPoint reads the colour map, the font scheme and the format scheme from
 * here; a master pointing at a theme that lacks any of the three opens as a
 * repair prompt. The values are the Office defaults, written out rather than
 * inherited, because there is nothing to inherit from in a package this file
 * builds from scratch.
 */
const themeColor = (name: string, value: string) =>
  `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;

const THEME_XML =
  `${XML_DECLARATION}` +
  `<a:theme ${A_NS} name="Tomverse"><a:themeElements>` +
  `<a:clrScheme name="Tomverse">` +
  `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
  `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  themeColor("dk2", "44546A") +
  themeColor("lt2", "E7E6E6") +
  themeColor("accent1", "1F6F4A") +
  themeColor("accent2", "2E75B6") +
  themeColor("accent3", "A5A5A5") +
  themeColor("accent4", "FFC000") +
  themeColor("accent5", "5B9BD5") +
  themeColor("accent6", "70AD47") +
  themeColor("hlink", "0563C1") +
  themeColor("folHlink", "954F72") +
  `</a:clrScheme>` +
  `<a:fontScheme name="Tomverse">` +
  `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont>` +
  `</a:fontScheme>` +
  `<a:fmtScheme name="Tomverse">` +
  `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
  `<a:lnStyleLst>` +
  `<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `</a:lnStyleLst>` +
  `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
  `</a:fmtScheme></a:themeElements></a:theme>`;

const EMPTY_TREE =
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;

const COLOUR_MAP =
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" ` +
  `accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" ` +
  `accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;

const SLIDE_MASTER_XML =
  `${XML_DECLARATION}` +
  `<p:sldMaster ${A_NS} ${P_NS} ${R_NS}><p:cSld>${EMPTY_TREE}</p:cSld>${COLOUR_MAP}` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `</p:sldMaster>`;

const SLIDE_LAYOUT_XML =
  `${XML_DECLARATION}` +
  `<p:sldLayout ${A_NS} ${P_NS} ${R_NS} type="blank" preserve="1">` +
  `<p:cSld name="Blank">${EMPTY_TREE}</p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const NOTES_MASTER_XML =
  `${XML_DECLARATION}` +
  `<p:notesMaster ${A_NS} ${P_NS} ${R_NS}><p:cSld>${EMPTY_TREE}</p:cSld>${COLOUR_MAP}` +
  `</p:notesMaster>`;

/** The PresentationML package for an admitted presentation specification. */
export const renderPresentationPptx = (spec: PresentationSpec): Uint8Array => {
  const slides = spec.slides;
  const notesBySlide = new Map<number, string>();
  slides.forEach((slide, index) => {
    if (slide.notes && slide.notes.trim()) notesBySlide.set(index, slide.notes);
  });
  const hasNotes = notesBySlide.size > 0;

  const parts: OoxmlPart[] = [];

  // --- content types ------------------------------------------------------
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    ...slides.map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    ),
    ...(hasNotes
      ? [
          `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`,
          ...[...notesBySlide.keys()].map(
            (index) =>
              `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
          ),
        ]
      : []),
    CORE_PROPERTIES_OVERRIDE,
  ];
  parts.push({
    path: "[Content_Types].xml",
    xml:
      `${XML_DECLARATION}` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      overrides.join("") +
      `</Types>`,
  });

  // --- package root -------------------------------------------------------
  parts.push({
    path: "_rels/.rels",
    xml:
      `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
      relationship("rId1", `${REL}/officeDocument`, "ppt/presentation.xml") +
      CORE_PROPERTIES_RELATIONSHIP +
      `</Relationships>`,
  });
  parts.push(CORE_PROPERTIES_PART);

  // --- presentation -------------------------------------------------------
  // Slide ids start at 256: PowerPoint reserves everything below it.
  const slideIdList = slides
    .map(
      (_, index) =>
        `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`
    )
    .join("");
  parts.push({
    path: "ppt/presentation.xml",
    xml:
      `${XML_DECLARATION}` +
      `<p:presentation ${A_NS} ${P_NS} ${R_NS} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>` +
      (hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster"/></p:notesMasterIdLst>` : "") +
      `<p:sldIdLst>${slideIdList}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/>` +
      `</p:presentation>`,
  });

  const presentationRels = [
    relationship("rIdMaster", `${REL}/slideMaster`, "slideMasters/slideMaster1.xml"),
    relationship("rIdTheme", `${REL}/theme`, "theme/theme1.xml"),
    ...slides.map((_, index) =>
      relationship(
        `rIdSlide${index + 1}`,
        `${REL}/slide`,
        `slides/slide${index + 1}.xml`
      )
    ),
    ...(hasNotes
      ? [
          relationship(
            "rIdNotesMaster",
            `${REL}/notesMaster`,
            "notesMasters/notesMaster1.xml"
          ),
        ]
      : []),
  ];
  parts.push({
    path: "ppt/_rels/presentation.xml.rels",
    xml: `${XML_DECLARATION}${RELATIONSHIPS_OPEN}${presentationRels.join("")}</Relationships>`,
  });

  // --- master, layout, theme ---------------------------------------------
  parts.push({ path: "ppt/slideMasters/slideMaster1.xml", xml: SLIDE_MASTER_XML });
  parts.push({
    path: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    xml:
      `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
      relationship("rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml") +
      relationship("rId2", `${REL}/theme`, "../theme/theme1.xml") +
      `</Relationships>`,
  });
  parts.push({ path: "ppt/slideLayouts/slideLayout1.xml", xml: SLIDE_LAYOUT_XML });
  parts.push({
    path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    xml:
      `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
      relationship("rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml") +
      `</Relationships>`,
  });
  parts.push({ path: "ppt/theme/theme1.xml", xml: THEME_XML });

  // --- slides -------------------------------------------------------------
  slides.forEach((slide, index) => {
    parts.push({
      path: `ppt/slides/slide${index + 1}.xml`,
      xml: slideXml(slide),
    });
    const notes = notesBySlide.get(index);
    parts.push({
      path: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      xml:
        `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
        relationship("rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml") +
        (notes
          ? relationship(
              "rId2",
              `${REL}/notesSlide`,
              `../notesSlides/notesSlide${index + 1}.xml`
            )
          : "") +
        `</Relationships>`,
    });
  });

  // --- notes --------------------------------------------------------------
  if (hasNotes) {
    parts.push({ path: "ppt/notesMasters/notesMaster1.xml", xml: NOTES_MASTER_XML });
    parts.push({
      path: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      xml:
        `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
        relationship("rId1", `${REL}/theme`, "../theme/theme1.xml") +
        `</Relationships>`,
    });
    for (const [index, notes] of notesBySlide) {
      parts.push({
        path: `ppt/notesSlides/notesSlide${index + 1}.xml`,
        xml: notesSlideXml(notes),
      });
      parts.push({
        path: `ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`,
        xml:
          `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
          relationship("rId1", `${REL}/slide`, `../slides/slide${index + 1}.xml`) +
          relationship(
            "rId2",
            `${REL}/notesMaster`,
            "../notesMasters/notesMaster1.xml"
          ) +
          `</Relationships>`,
      });
    }
  }

  return zipOoxmlPackage(parts);
};
