-- Converted images join the formats a stored artifact may have.
--
-- Policy: docs/policy/generated-artifacts.md sections 4 and 14.
--
-- `convert_files` turns files the user attached into other files, and three of
-- its outputs are raster images: a PDF page drawn as a picture, and an image
-- re-saved in another format. Additive only -- every existing row already
-- satisfies the wider list, and no format is removed.
--
-- The list is SUPPORTED_ARTIFACT_FORMATS (lib/generatedArtifactFormats.ts);
-- scripts/check-enum-constraints.mjs holds the two together.
ALTER TABLE "MessageArtifact"
    DROP CONSTRAINT "MessageArtifact_format_check",
    ADD CONSTRAINT "MessageArtifact_format_check"
        CHECK ("format" IN (
            'xlsx', 'docx', 'pptx', 'pdf', 'csv', 'md', 'txt', 'json', 'yaml',
            'yml', 'xml', 'toml', 'ini', 'tsv', 'html', 'htm', 'svg', 'css',
            'scss', 'less', 'sql', 'graphql', 'proto', 'ts', 'tsx', 'js', 'jsx',
            'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c',
            'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'ps1', 'r', 'scala',
            'lua', 'pl', 'dart', 'ex', 'exs', 'hs', 'vue', 'svelte', 'dockerfile',
            'env', 'zip', 'png', 'jpg', 'webp'
        ));
