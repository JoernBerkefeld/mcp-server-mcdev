import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

const MAX_LINE = 4096;
const MAX_MESSAGES = 32;
const MAX_TEXT = 4096;
const SLICE_SIZE = 1024;

type Stream = 'stdout' | 'stderr';

/** A fixed diagnostic category, never a copy of untrusted process output. */
export interface NativeDiagnostic {
    readonly stream: Stream;
    readonly code: string;
    readonly message: string;
}

/** Bounded projection only: this is not raw output, universal redaction, or artifact evidence. */
export interface NativeDiagnostics {
    readonly messages: readonly NativeDiagnostic[];
    readonly suppressed: boolean;
    readonly truncated: boolean;
}

// Review new templates against mcdev's logger callsites before adding them. Captures must
// never be interpolated: even metadata names, filesystem errors and SDK messages can be secrets.
// Sources: mcdev lib/util/config.js, lib/util/auth.js, lib/index.js,
// lib/Retriever.js, lib/Builder.js, lib/Deployer.js, lib/util/util.js,
// lib/metadataTypes/{MetadataType,Journey,TriggeredSend}.js (10.1.x).
const PROJECTIONS: readonly (readonly [RegExp, string, string])[] = [
    [
        /^Could not find \.mcdevrc\.json in .+\.$/u,
        'configuration-missing',
        'Project configuration is missing. Initialize the project with mcdev init.',
    ],
    [
        /^(?:Could not find \.mcdev-auth\.json in .+\.|\.mcdev-auth\.json not found\..*)$/u,
        'authentication-missing',
        'Local authentication configuration is missing. Configure credentials with mcdev init.',
    ],
    [
        /^Run 'mcdev init' to initialize your project\.$/u,
        'initialization-required',
        'mcdev requests project initialization with mcdev init.',
    ],
    [
        /^Run 'mcdev upgrade' now to fix this\.$/u,
        'upgrade-required',
        'mcdev requests a project configuration upgrade. Review mcdev upgrade.',
    ],
    [
        /^Your Accenture SFMC DevTools version \d+\.\d+\.\d+ is lower than your project's config version \d+\.\d+\.\d+$/u,
        'version-mismatch',
        'The mcdev runtime is older than the project configuration. Update the selected runtime.',
    ],
    [
        /^Installed package has insufficient access\. You might encounter malfunctions!$/u,
        'insufficient-access',
        'The installed package has insufficient access. Review its granted permissions.',
    ],
    [
        /^Missing scope: .+$/u,
        'missing-scope',
        'mcdev reports missing installed-package scopes. Review its granted permissions.',
    ],
    [
        /^- Retrieving [a-zA-Z][a-zA-Z\d_-]* failed$/u,
        'retrieve-failed',
        'Metadata retrieval failed. Check permissions, connectivity and the selected metadata type.',
    ],
    [
        /^Downloaded: [a-zA-Z][a-zA-Z\d_-]* \(\d+\)(?: .*)?$/u,
        'download-reported',
        'mcdev reported a metadata download. This does not verify saved artifacts or completeness.',
    ],
    [
        /^(?:Error: )?(?:connect |getaddrinfo |read )?(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)(?:\b.*)?$/u,
        'connection-failed',
        'A network connection failed. Check connectivity and retry when appropriate.',
    ],
    [
        /^(?:Error: )?(?:EACCES|EPERM)(?:\b.*)?$/u,
        'filesystem-access-denied',
        'Filesystem access was denied. Check project directory permissions.',
    ],
    [
        /^No templates created\. Aborting build$/u,
        'build-no-templates',
        'No templates were created. Check the selected metadata keys and retrieved source before rebuilding.',
    ],
    [
        /^:: '.+' is not a valid metadata type(?:\. Please don't include subtypes\.)?$/u,
        'metadata-type-invalid',
        'The metadata selector is invalid. Check supported metadata types; template builds require a base type without subtypes.',
    ],
    [
        /^Could not find the market '.+' in your configuration file\.$/u,
        'build-market-missing',
        'The selected market is missing from project configuration. Check the markets configuration before rebuilding.',
    ],
    [
        /^☇ skipped [a-zA-Z][a-zA-Z\d_-]* .+: template not found$/u,
        'build-template-missing',
        'A selected template was not found. Check the template name and configured template directory before rebuilding.',
    ],
    [
        /^mcdev\.buildDefinition: .+$/u,
        'build-definition-failed',
        'Definition building failed. Check template files, replacement values and the configured build directories.',
    ],
    [
        /^Please define properties\.marketList in your config$/u,
        'build-market-list-missing',
        'Bulk building requires a market list. Define marketList in project configuration before rebuilding.',
    ],
    [
        /^Please create a directory called deploy and include your metadata in it: .+$/u,
        'deploy-directory-missing',
        'The deploy directory is missing. Build or place reviewed metadata in the configured deploy directory first.',
    ],
    [
        /^(?:No metadata found in deploy folder for selected BU(?: & type)?|No metadata found for deployment)$/u,
        'deploy-metadata-missing',
        'No deployable metadata was found. Check the selected business unit, metadata type and deploy directory contents.',
    ],
    [
        /^No deployable metadata found for type [a-zA-Z][a-zA-Z\d_-]*(?: with keys .+)?$/u,
        'deploy-selection-empty',
        'The deployment selection has no deployable metadata. Check the selected type and keys against local deploy files.',
    ],
    [
        /^(?:mcdev\.deploy failed|Upserting [a-zA-Z][a-zA-Z\d_-]* failed): .+$/u,
        'deploy-failed',
        'Deployment failed. Review local metadata, target dependencies and permissions before retrying; remote changes may be partial.',
    ],
    [
        /^[a-zA-Z][a-zA-Z\d_-]* upsert: \d+ of \d+ created \/ \d+ of \d+ updated(?: \/ \d+ filtered)?$/u,
        'deploy-upsert-reported',
        'mcdev reported deployment create/update totals. Review skipped or failed items; this does not verify remote state or completeness.',
    ],
    [
        /^- failed to publish [a-zA-Z][a-zA-Z\d_ -]*: .+ - .+$/u,
        'publish-failed',
        'Publishing failed. Check target content and publication prerequisites; deployment alone does not establish publication.',
    ],
    [
        /^Published \d+ of \d+ items$/u,
        'publish-summary-reported',
        'mcdev reported a publication summary. Check for failed or skipped items; this does not independently verify publication.',
    ],
    [
        /^mcdev:: Retrieve$/u,
        'retrieve-started',
        'mcdev started a retrieval operation. Completion is not established.',
    ],
];

const createStreamState = () => ({ decoder: new StringDecoder('utf8'), line: '', overflow: false });

/**
 * Create an in-memory, draining diagnostic projection with independent UTF-8 stream decoders.
 * Only reviewed message templates produce fixed text; arbitrary text is suppressed, not redacted.
 * Lines above 4096 UTF-16 units are discarded; at most 32 messages / 4096 text units are kept.
 * finish flushes unterminated lines, returns an immutable snapshot and is idempotent.
 * Writes after finish are ignored. This helper does not read files or execute commands.
 * @returns {object} Collector accepting stdout/stderr chunks and producing bounded diagnostic evidence.
 */
export function createNativeDiagnostics(): {
    write: (stream: Stream, chunk: Buffer | string) => void;
    finish: () => NativeDiagnostics;
} {
    const streams = { stdout: createStreamState(), stderr: createStreamState() };
    const messages: NativeDiagnostic[] = [];
    let suppressed = false;
    let truncated = false;
    let retainedText = 0;
    let snapshot: NativeDiagnostics | undefined;

    const project = (stream: Stream) => {
        const pending = streams[stream];
        if (pending.overflow) {
            pending.overflow = false;
            pending.line = '';
            suppressed = true;
            truncated = true;
            return;
        }
        const line = stripVTControlCharacters(pending.line)
            .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
            .trim();
        pending.line = '';
        if (!line) return;
        const message = line.replace(
            /^(?:\d{2}:\d{2}:\d{2}(?:\.\d{3})? )?(?:info|warn|error):\s*/u,
            ''
        );
        // Reject payload/debug-shaped lines even if they contain a familiar error label.
        if (
            /(?:^|\s)(?:debug|verbose|trace):|[{}<>]|bearer\s|authorization|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password/iu.test(
                line
            )
        ) {
            suppressed = true;
            return;
        }
        const template = PROJECTIONS.find(([pattern]) => pattern.test(message));
        if (!template) {
            suppressed = true;
            return;
        }
        const [, code, text] = template;
        if (messages.length >= MAX_MESSAGES || retainedText + text.length > MAX_TEXT) {
            truncated = true;
            return;
        }
        messages.push(Object.freeze({ stream, code, message: text }));
        retainedText += text.length;
    };

    const consume = (stream: Stream, text: string) => {
        const pending = streams[stream];
        for (const character of text) {
            if (character === '\n' || character === '\r') {
                project(stream);
            } else if (!pending.overflow) {
                if (pending.line.length + character.length > MAX_LINE) {
                    pending.line = '';
                    pending.overflow = true;
                } else {
                    pending.line += character;
                }
            }
        }
    };

    return {
        write(stream, chunk) {
            if (snapshot) return;
            const pending = streams[stream];
            // Decode bounded slices, not an arbitrarily large input buffer at once.
            if (typeof chunk === 'string') {
                consume(stream, pending.decoder.end());
                pending.decoder = new StringDecoder('utf8');
                for (let offset = 0; offset < chunk.length; offset += SLICE_SIZE) {
                    consume(stream, chunk.slice(offset, offset + SLICE_SIZE));
                }
            } else {
                for (let offset = 0; offset < chunk.length; offset += SLICE_SIZE) {
                    consume(
                        stream,
                        pending.decoder.write(chunk.subarray(offset, offset + SLICE_SIZE))
                    );
                }
            }
        },
        finish() {
            if (!snapshot) {
                for (const stream of ['stdout', 'stderr'] as const) {
                    consume(stream, streams[stream].decoder.end());
                    project(stream);
                }
                snapshot = Object.freeze({
                    messages: Object.freeze([...messages]),
                    suppressed,
                    truncated,
                });
            }
            return snapshot;
        },
    };
}
