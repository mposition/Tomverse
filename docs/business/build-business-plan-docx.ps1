param(
  [Parameter(Mandatory = $false)]
  [string]$InputPath = (Join-Path $PSScriptRoot 'Tomverse-Business-Plan-Draft-2026-07-16.md'),
  [Parameter(Mandatory = $false)]
  [string]$OutputPath = (Join-Path $PSScriptRoot 'Tomverse-Business-Plan-Draft-2026-07-16.docx')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function XmlEscape([string]$Value) {
  if ($null -eq $Value) { return '' }
  return [System.Security.SecurityElement]::Escape($Value)
}

function CleanInline([string]$Value) {
  $cleaned = $Value -replace '\*\*', ''
  $cleaned = $cleaned -replace '`', ''
  return $cleaned.Trim()
}

function ParagraphXml {
  param(
    [string]$Text,
    [string]$Style = 'Normal',
    [int]$NumId = 0,
    [int]$Level = 0,
    [switch]$PageBreakBefore,
    [switch]$KeepNext,
    [switch]$Italic,
    [string]$Color = ''
  )

  $properties = "<w:pStyle w:val=`"$Style`"/>"
  if ($NumId -gt 0) {
    $properties += "<w:numPr><w:ilvl w:val=`"$Level`"/><w:numId w:val=`"$NumId`"/></w:numPr>"
  }
  if ($PageBreakBefore) { $properties += '<w:pageBreakBefore/>' }
  if ($KeepNext) { $properties += '<w:keepNext/>' }

  $runProps = ''
  if ($Italic) { $runProps += '<w:i/>' }
  if ($Color) { $runProps += "<w:color w:val=`"$Color`"/>" }
  if ($runProps) { $runProps = "<w:rPr>$runProps</w:rPr>" }

  $escaped = XmlEscape (CleanInline $Text)
  return "<w:p><w:pPr>$properties</w:pPr><w:r>$runProps<w:t xml:space=`"preserve`">$escaped</w:t></w:r></w:p>"
}

function EmptyParagraphXml {
  return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
}

function TableXml([string[][]]$Rows) {
  if ($Rows.Count -eq 0) { return '' }
  $columnCount = ($Rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
  $gridWidth = [Math]::Floor(9000 / [Math]::Max(1, $columnCount))
  $grid = (1..$columnCount | ForEach-Object { "<w:gridCol w:w=`"$gridWidth`"/>" }) -join ''
  $rowXml = New-Object System.Collections.Generic.List[string]

  for ($rowIndex = 0; $rowIndex -lt $Rows.Count; $rowIndex++) {
    $cells = New-Object System.Collections.Generic.List[string]
    for ($columnIndex = 0; $columnIndex -lt $columnCount; $columnIndex++) {
      $value = if ($columnIndex -lt $Rows[$rowIndex].Count) { $Rows[$rowIndex][$columnIndex] } else { '' }
      $escaped = XmlEscape (CleanInline $value)
      $cellProps = "<w:tcW w:w=`"$gridWidth`" w:type=`"dxa`"/><w:vAlign w:val=`"center`"/>"
      $runProps = ''
      if ($rowIndex -eq 0) {
        $cellProps += '<w:shd w:val="clear" w:color="auto" w:fill="155EEF"/>'
        $runProps = '<w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>'
      } elseif ($rowIndex % 2 -eq 0) {
        $cellProps += '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/>'
      }
      $cells.Add("<w:tc><w:tcPr>$cellProps</w:tcPr><w:p><w:pPr><w:spacing w:after=`"0`"/></w:pPr><w:r>$runProps<w:t xml:space=`"preserve`">$escaped</w:t></w:r></w:p></w:tc>")
    }
    $rowXml.Add("<w:tr>$($cells -join '')</w:tr>")
  }

  return "<w:tbl><w:tblPr><w:tblW w:w=`"0`" w:type=`"auto`"/><w:tblLayout w:type=`"fixed`"/><w:tblBorders><w:top w:val=`"single`" w:sz=`"4`" w:color=`"D0D5DD`"/><w:left w:val=`"single`" w:sz=`"4`" w:color=`"D0D5DD`"/><w:bottom w:val=`"single`" w:sz=`"4`" w:color=`"D0D5DD`"/><w:right w:val=`"single`" w:sz=`"4`" w:color=`"D0D5DD`"/><w:insideH w:val=`"single`" w:sz=`"4`" w:color=`"D0D5DD`"/><w:insideV w:val=`"single`" w:sz=`"4`" w:color=`"D0D5DD`"/></w:tblBorders><w:tblCellMar><w:top w:w=`"100`" w:type=`"dxa`"/><w:left w:w=`"120`" w:type=`"dxa`"/><w:bottom w:w=`"100`" w:type=`"dxa`"/><w:right w:w=`"120`" w:type=`"dxa`"/></w:tblCellMar></w:tblPr><w:tblGrid>$grid</w:tblGrid>$($rowXml -join '')</w:tbl>"
}

$lines = [System.IO.File]::ReadAllLines((Resolve-Path $InputPath), [System.Text.Encoding]::UTF8)
$body = New-Object System.Collections.Generic.List[string]
$firstRule = $true

for ($i = 0; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]

  if ($line -match '^\|.*\|\s*$' -and $i + 1 -lt $lines.Count -and $lines[$i + 1] -match '^\|?[\s:\-\|]+\|\s*$') {
    $rows = New-Object System.Collections.Generic.List[object]
    $header = $line.Trim().Trim('|').Split('|') | ForEach-Object { $_.Trim() }
    $rows.Add([string[]]$header)
    $i += 2
    while ($i -lt $lines.Count -and $lines[$i] -match '^\|.*\|\s*$') {
      $row = $lines[$i].Trim().Trim('|').Split('|') | ForEach-Object { $_.Trim() }
      $rows.Add([string[]]$row)
      $i++
    }
    $i--
    $body.Add((TableXml ([string[][]]$rows.ToArray())))
    $body.Add((EmptyParagraphXml))
    continue
  }

  if ($line -match '^# (.+)$') {
    $body.Add((ParagraphXml -Text $Matches[1] -Style 'Title' -KeepNext))
  } elseif ($line -match '^## (.+)$') {
    $style = if ($Matches[1] -in @('Business Plan — Working Draft', '비즈니스 플랜 — 실무 초안')) { 'Subtitle' } else { 'Heading1' }
    $body.Add((ParagraphXml -Text $Matches[1] -Style $style -KeepNext))
  } elseif ($line -match '^### (.+)$') {
    $body.Add((ParagraphXml -Text $Matches[1] -Style 'Heading2' -KeepNext))
  } elseif ($line -match '^#### (.+)$') {
    $body.Add((ParagraphXml -Text $Matches[1] -Style 'Heading3' -KeepNext))
  } elseif ($line -match '^>\s*(.+)$') {
    $body.Add((ParagraphXml -Text $Matches[1] -Style 'Quote' -Italic -Color '344054'))
  } elseif ($line -match '^\s*-\s+(.+)$') {
    $body.Add((ParagraphXml -Text $Matches[1] -Style 'ListParagraph' -NumId 1))
  } elseif ($line -match '^\s*\d+\.\s+(.+)$') {
    $body.Add((ParagraphXml -Text $Matches[1] -Style 'ListParagraph' -NumId 2))
  } elseif ($line -match '^---\s*$') {
    if ($firstRule) {
      $body.Add('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
      $firstRule = $false
    } else {
      $body.Add((EmptyParagraphXml))
    }
  } elseif ([string]::IsNullOrWhiteSpace($line)) {
    # Word paragraph spacing provides the visual break.
  } else {
    $body.Add((ParagraphXml -Text $line))
  }
}

$documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    $($body -join "`n")
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="540" w:footer="540" w:gutter="0"/>
      <w:cols w:space="720"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>
"@

$stylesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="21"/><w:color w:val="1D2939"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:qFormat/><w:pPr><w:spacing w:before="2200" w:after="220"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:color w:val="155EEF"/><w:sz w:val="54"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="500"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:color w:val="475467"/><w:sz w:val="30"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:color w:val="155EEF"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="344054"/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="475467"/><w:sz w:val="23"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="180"/><w:contextualSpacing/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="480" w:right="480"/><w:spacing w:before="200" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="344054"/><w:sz w:val="25"/></w:rPr></w:style>
</w:styles>
'@

$numberingXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
'@

$contentTypesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
'@

$rootRelsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
'@

$documentRelsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>
'@

$timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$coreXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Tomverse Business Plan — Working Draft</dc:title>
  <dc:subject>Business plan and go-to-market strategy</dc:subject>
  <dc:creator>Tomverse</dc:creator>
  <cp:keywords>Tomverse, business plan, AI comparison, AI Review</cp:keywords>
  <dc:description>Internal business plan draft prepared from the current Tomverse product and strategy.</dc:description>
  <dcterms:created xsi:type="dcterms:W3CDTF">$timestamp</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">$timestamp</dcterms:modified>
</cp:coreProperties>
"@

$appXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Tomverse Document Builder</Application>
  <AppVersion>1.0</AppVersion>
</Properties>
'@

if (Test-Path $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory | Out-Null }

$stream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::CreateNew)
try {
  $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    $parts = [ordered]@{
      '[Content_Types].xml' = $contentTypesXml
      '_rels/.rels' = $rootRelsXml
      'word/document.xml' = $documentXml
      'word/styles.xml' = $stylesXml
      'word/numbering.xml' = $numberingXml
      'word/_rels/document.xml.rels' = $documentRelsXml
      'docProps/core.xml' = $coreXml
      'docProps/app.xml' = $appXml
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    foreach ($part in $parts.GetEnumerator()) {
      $entry = $archive.CreateEntry($part.Key, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try {
        $writer = New-Object System.IO.StreamWriter($entryStream, $utf8NoBom)
        try { $writer.Write($part.Value) } finally { $writer.Dispose() }
      } finally { $entryStream.Dispose() }
    }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

Write-Output "Created $OutputPath"
