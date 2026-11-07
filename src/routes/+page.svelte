<script lang="ts">
  import { onMount } from "svelte";
  import { pastedImages } from "#lib/clipboard.ts";
  import About from "#lib/components/About.svelte";
  import Seo from "#lib/components/Seo.svelte";
  import Icon from "#lib/components/Icon.svelte";
  import Dropdown from "#lib/components/Dropdown.svelte";
  import Navbar from "#lib/vert/Navbar.svelte";
  import Uploader from "#lib/vert/Uploader.svelte";
  import {
    acceptFiles,
    extension,
    fileError,
    formatBytes,
    joinPages,
    officeExtensions,
    textFilename,
  } from "#lib/files.ts";
  import {
    defaultOptions,
    type DocumentJob,
    type OcrOptions,
  } from "#lib/types.ts";
  import type { OcrSession } from "#lib/ocr.client.ts";

  let input: HTMLInputElement;
  let jobs = $state<DocumentJob[]>([]);
  let options = $state<OcrOptions>({ ...defaultOptions });
  let busy = $state(false);
  let showSettings = $state(false);
  let activePage = $state<"upload" | "convert" | "about">("upload");
  let light = $state(false);
  let error = $state("");
  let selectedId = $state("");
  let selectedPage = $state(0);
  let view = $state<"split" | "text">("split");
  let copied = $state(false);
  let officeAvailable = $state<boolean | null>(null);
  let abortController: AbortController | undefined;
  let session: OcrSession | undefined;
  let copyTimer: ReturnType<typeof setTimeout>;
  const selected = $derived(jobs.find((job) => job.id === selectedId));
  const page = $derived(selected?.pages[selectedPage]);
  const pending = $derived(jobs.filter((job) => job.status === "queued"));
  const completed = $derived(jobs.filter((job) => job.status === "done"));
  const pageCount = $derived(
    jobs.reduce((sum, job) => sum + job.pages.length, 0),
  );

  onMount(() => {
    if (window.location.hash === "#about") activePage = "about";
    light = localStorage.getItem("khmer-ocr-theme") === "light";
    fetch("/api/render")
      .then((response) => response.json())
      .then((data) => {
        officeAvailable = data.available;
      })
      .catch(() => {
        officeAvailable = false;
      });
    return () => {
      abortController?.abort();
      void session?.dispose();
      clearTimeout(copyTimer);
    };
  });

  $effect(() => {
    document.documentElement.classList.toggle("light", light);
    document.documentElement.classList.toggle("dark", !light);
  });

  function toggleTheme() {
    light = !light;
    localStorage.setItem("khmer-ocr-theme", light ? "light" : "dark");
  }

  function addFiles(files: FileList | File[]) {
    error = "";
    const rejected: string[] = [];
    const previousCount = jobs.length;
    for (const file of Array.from(files)) {
      const problem = fileError(file);
      if (problem) {
        rejected.push(problem);
        continue;
      }
      if (jobs.length >= 20) {
        rejected.push("Add up to 20 files at a time.");
        break;
      }
      if (
        jobs.some(
          (job) =>
            job.file.name === file.name &&
            job.file.size === file.size &&
            job.file.lastModified === file.lastModified,
        )
      )
        continue;
      jobs.push({
        id: crypto.randomUUID(),
        file,
        status: "queued",
        progress: 0,
        stage: "Ready",
        pages: [],
      });
    }
    error = rejected.join(" ");
    if (jobs.length > previousCount) {
      activePage = "convert";
      showSettings = false;
    }
    if (!selectedId && jobs.length) selectedId = jobs[0].id;
  }

  function pasteImages(event: ClipboardEvent) {
    if (showSettings || activePage === "about" || !event.clipboardData || event.defaultPrevented) return;
    // Preserve normal paste in the OCR editor and other editable fields.
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const files = pastedImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  }

  function removeFile(id: string) {
    jobs = jobs.filter((job) => job.id !== id);
    if (selectedId === id) {
      selectedId = jobs[0]?.id ?? "";
      selectedPage = 0;
    }
  }

  async function convert() {
    if (busy || !pending.length) return;
    busy = true;
    error = "";
    copied = false;
    abortController = new AbortController();
    const signal = abortController.signal;
    try {
      const { OcrSession } = await import("#lib/ocr.client.ts");
      session = new OcrSession({ ...options }, signal);
      for (const job of [...pending]) {
        if (signal.aborted) break;
        selectedId = job.id;
        selectedPage = 0;
        job.status = "processing";
        job.pages = [];
        job.error = undefined;
        let onAbort: (() => void) | undefined;
        try {
          const cancelled = new Promise<never>((_, reject) => {
            onAbort = () =>
              reject(new DOMException("Conversion cancelled.", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
          });
          await Promise.race([
            session.process(job.file, {
              progress: (value, stage) => {
                if (!signal.aborted) {
                  job.progress = Math.round(value);
                  job.stage = stage;
                }
              },
              page: (result) => {
                if (!signal.aborted) job.pages.push(result);
              },
            }),
            cancelled,
          ]);
          job.status = "done";
          job.progress = 100;
          job.stage = `${job.pages.length} ${job.pages.length === 1 ? "page" : "pages"}`;
        } catch (cause) {
          if (signal.aborted) {
            job.status = "cancelled";
            job.stage = "Cancelled";
          } else {
            job.status = "error";
            job.error =
              cause instanceof Error
                ? cause.message
                : typeof cause === "string"
                  ? cause
                  : "Something went wrong. Try another file.";
            job.stage = "Conversion failed";
          }
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not start OCR.";
    } finally {
      await session?.dispose();
      session = undefined;
      busy = false;
    }
  }

  function retry(job: DocumentJob) {
    job.status = "queued";
    job.progress = 0;
    job.stage = "Ready";
    job.error = undefined;
  }

  function download(text: string, filename: string) {
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyText() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(joinPages(selected.pages));
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      error =
        "Clipboard access is unavailable. Select the text to copy it manually.";
    }
  }

</script>

<svelte:window onpaste={pasteImages} />

<Seo
  title="Core — Khmer OCR & PDF to Editable Text"
  description="Extract editable Khmer and English text from PDFs, scanned documents, and images with Core. Review page previews, correct results, and export Unicode text."
/>

<div class="app-shell" class:extraction-view={activePage === "convert" && !showSettings}>
  <div class="vert-glow" aria-hidden="true"></div>
  <header>
    <Navbar
      count={jobs.length}
      active={showSettings ? "settings" : activePage}
      {light}
      onupload={() => {
        showSettings = false;
        activePage = "upload";
      }}
      onconvert={() => {
        showSettings = false;
        activePage = "convert";
      }}
      onsettings={() => {
        showSettings = !showSettings;
      }}
      onabout={() => {
        showSettings = false;
        activePage = "about";
      }}
      ontheme={toggleTheme}
    />
  </header>

  <main>
    <input
      bind:this={input}
      type="file"
      accept={acceptFiles}
      multiple
      class="visually-hidden"
      aria-label="Choose files to convert"
      onchange={(event) => {
        if (event.currentTarget.files) addFiles(event.currentTarget.files);
        event.currentTarget.value = "";
      }}
    />

    {#if activePage === "upload" && !showSettings}
    <section
      id="upload-area"
      class="hero-grid"
      aria-label="Upload files for Core"
    >
      <div class="tool-heading">
        <h1>Core.</h1>
        <p>
          PDFs, documents & images<br class="desktop-break" /> to editable text.
        </p>
        <span class="upload-limits">50 MB per file · up to 200 pages</span>
      </div>
      <Uploader
        onbrowse={() => input.click()}
        onfiles={addFiles}
      />
    </section>

    <div class="processing-note">
      <span>Supports PDF, DOC, DOCX, ODT, RTF, PNG, JPG, JPEG, WebP & BMP.</span>
    </div>
    {/if}

    {#if activePage === "convert" && !showSettings}
      <section class="extraction-toolbar" aria-label="Extraction actions">
        {#if busy}
          <button class="secondary-button" onclick={() => abortController?.abort()}><Icon name="StopCircle" size={20} />Cancel extraction</button>
        {:else}
          <button class="primary-button" disabled={!pending.length} onclick={convert}><Icon name="RefreshCw" size={22} />Extract all</button>
        {/if}
        <button class="secondary-button toolbar-download" aria-label="Download all as text" disabled={!completed.length} onclick={() => download(completed.map((job) => `${job.file.name}\n\n${joinPages(job.pages)}`).join("\n\n────────────\n\n"), "core.txt")}><Icon name="Download" size={22} /><span>Download all .txt</span></button>
        <button class="toolbar-clear secondary-button" aria-label="Clear all files" disabled={busy || !jobs.length} onclick={() => { jobs = []; selectedId = ""; selectedPage = 0; }}><Icon name="Trash2" size={22} /></button>
        <span class="toolbar-summary">{jobs.length} {jobs.length === 1 ? 'file' : 'files'}<span class="output-format">.txt</span></span>
      </section>
      <section class="workspace-upload" aria-label="Add files to extract">
        <Uploader onbrowse={() => input.click()} onfiles={addFiles} compact={jobs.length > 0} workspace />
      </section>
    <div class="configuration">
      <div class="config-item">
        <span class="config-label">Language</span>
        <Dropdown
          label="OCR language"
          bind:value={options.language}
          options={[{ value: 'khm+eng', label: 'Khmer + English' }, { value: 'khm', label: 'Khmer' }, { value: 'eng', label: 'English' }]}
          disabled={busy}
          inline
        />
      </div>
      <span class="config-divider"></span>
      <div class="config-item">
        <span class="config-label">Model</span>
        <Dropdown
          label="OCR model"
          bind:value={options.quality}
          options={[{ value: 'best', label: 'Accurate' }, { value: 'fast', label: 'Fast' }]}
          disabled={busy}
          inline
        />
      </div>
      <span class="config-divider desktop-only"></span>
      <button
        class:chosen={showSettings}
        class="advanced-button"
        aria-label="OCR options"
        aria-expanded={showSettings}
        aria-controls="settings"
        onclick={() => {
          showSettings = !showSettings;
        }}
        ><Icon name="SlidersHorizontal" size={15} /><span>Options</span></button
      >
    </div>
    {/if}

    {#if showSettings}
      <section id="settings" class="settings-panel" aria-label="OCR settings">
        <div class="settings-top">
          <h2>OCR options</h2>
          <button
            class="icon-button"
            aria-label="Close settings"
            onclick={() => {
              showSettings = false;
            }}><Icon name="X" size={17} /></button
          >
        </div>
        <div class="settings-grid">
          <div class="dropdown-setting">
            <span>PDF resolution</span>
            <Dropdown label="PDF resolution" bind:value={options.dpi} options={[{ value: 300, label: '300 DPI · detailed' }, { value: 200, label: '200 DPI · lighter' }]} disabled={busy} />
          </div>
          <div class="dropdown-setting">
            <span>Page layout</span>
            <Dropdown label="Page layout" bind:value={options.layout} options={[{ value: 'auto', label: 'Automatic' }, { value: 'column', label: 'Single column' }]} disabled={busy} />
          </div>
          <label class="checkbox-setting"
            ><input
              type="checkbox"
              bind:checked={options.enhance}
              disabled={busy}
            /><span
              >Enhance scans<small>Straighten, enlarge + improve contrast</small></span
            ></label
          >
        </div>
        <div class="renderer-status">
          <span class:unavailable={officeAvailable === false} class="status-dot"
          ></span>Office renderer: {officeAvailable === null
            ? "checking…"
            : officeAvailable
              ? "ready"
              : "LibreOffice required"}<span class="settings-hint"
            >PDFs and images work in your browser.</span
          >
        </div>
      </section>
    {/if}

    {#if error}<div class="error-banner" role="alert">
        <Icon name="AlertCircle" size={18} /><span>{error}</span><button
          class="icon-button"
          aria-label="Dismiss error"
          onclick={() => {
            error = "";
          }}><Icon name="X" size={16} /></button
        >
      </div>{/if}

    {#if activePage === "convert" && !showSettings && jobs.length}
      <section id="conversion-workspace" class="queue" aria-label="Files">
        <div class="section-heading">
          <h2>Files <span>{jobs.length.toString().padStart(2, "0")}</span></h2>

        </div>
        <div class="file-list">
          {#each jobs as job (job.id)}
            <div class:active-file={selectedId === job.id} class="file-row">
              <button
                class="file-select"
                onclick={() => {
                  selectedId = job.id;
                  selectedPage = 0;
                }}
                aria-label={`View ${job.file.name}`}
                aria-pressed={selectedId === job.id}
              >
                <span
                  class:pdf={extension(job.file.name) === "pdf"}
                  class:image={!officeExtensions.includes(
                    extension(job.file.name),
                  ) && extension(job.file.name) !== "pdf"}
                  class="file-icon"
                  ><Icon
                    name={extension(job.file.name) === "pdf" ||
                    officeExtensions.includes(extension(job.file.name))
                      ? "FileText"
                      : "Image"}
                    size={23}
                  /></span
                >
                <span class="file-info"
                  ><strong>{job.file.name}</strong><span
                    >{formatBytes(job.file.size)}<span class="dot-separator"
                      >·</span
                    >{extension(job.file.name).toUpperCase()}</span
                  ></span
                >
              </button>
              <div
                class:has-error={job.status === "error"}
                class:finished={job.status === "done"}
                class="job-status"
              >
                {#if job.status === "processing"}<Icon
                    name="LoaderCircle"
                    size={15}
                  /><span>{job.stage}</span><span class="percentage"
                    >{job.progress}%</span
                  >
                {:else if job.status === "done"}<Icon
                    name="Check"
                    size={16}
                  /><span>{job.stage}</span>
                {:else if job.status === "error"}<Icon
                    name="AlertCircle"
                    size={15}
                  /><span>Failed</span>
                {:else}<span class="status-dot neutral"></span><span
                    >{job.stage}</span
                  >{/if}
              </div>
              {#if (job.status === "error" || job.status === "cancelled") && !busy}<button
                  class="icon-button"
                  aria-label={`Retry ${job.file.name}`}
                  onclick={() => retry(job)}
                  ><Icon name="RotateCcw" size={16} /></button
                >{/if}
              {#if job.status === "done"}<button
                  class="icon-button"
                  aria-label={`Download ${job.file.name} as text`}
                  onclick={() =>
                    download(joinPages(job.pages), textFilename(job.file.name))}
                  ><Icon name="Download" size={17} /></button
                >{/if}
              <button
                class="icon-button remove-file"
                disabled={busy}
                aria-label={`Remove ${job.file.name}`}
                onclick={() => removeFile(job.id)}
                ><Icon name="X" size={17} /></button
              >
              {#if job.status === "processing"}<div
                  class="file-progress"
                  style={`width:${job.progress}%`}
                ></div>{/if}
            </div>
          {/each}
        </div>
        <div class="queue-actions">
          <span class="queue-note"
            >{busy
              ? "Keep this tab open while reading."
              : completed.length
                ? `${pageCount} ${pageCount === 1 ? "page" : "pages"} read`
                : "Ready when you are."}</span
          >
          <button class="text-button" onclick={() => input.click()}><Icon name="Plus" size={16} />Add files</button>
        </div>
      </section>
    {/if}

    {#if activePage === "convert" && !showSettings && selected?.error}<div class="error-banner" role="alert">
        <Icon name="AlertCircle" size={18} /><span>{selected.error}</span>
      </div>{/if}

    {#if activePage === "convert" && !showSettings && selected && selected.pages.length}
      <section class="results" aria-label="Extracted text">
        <div class="section-heading results-heading">
          <div class="result-title">
            <h2>Extracted text</h2>
            <span class="editable-badge">Editable</span>
          </div>
          <div class="result-actions">
            <button
              class="icon-button view-button"
              aria-label={view === "split"
                ? "Show text only"
                : "Show page preview"}
              aria-pressed={view === "split"}
              onclick={() => {
                view = view === "split" ? "text" : "split";
              }}><Icon name="FileText" size={17} /></button
            ><button class="secondary-button small" onclick={copyText}
              ><Icon name={copied ? "CheckCheck" : "Copy"} size={15} />{copied
                ? "Copied"
                : "Copy"}</button
            ><button
              class="primary-button small"
              onclick={() =>
                download(
                  joinPages(selected!.pages),
                  textFilename(selected!.file.name),
                )}><Icon name="Download" size={15} />Download .txt</button
            >
          </div>
        </div>
        {#if page}
          <div class="editor-toolbar">
            <div class="page-pagination">
              <button
                class="icon-button"
                disabled={selectedPage === 0}
                aria-label="Previous page"
                onclick={() => {
                  selectedPage--;
                }}><Icon name="ChevronLeft" size={17} /></button
              ><span
                >Page {selectedPage + 1}
                <span class="muted">/ {selected.pages.length}</span></span
              ><button
                class="icon-button"
                disabled={selectedPage === selected.pages.length - 1}
                aria-label="Next page"
                onclick={() => {
                  selectedPage++;
                }}><Icon name="ChevronRight" size={17} /></button
              >
            </div>
            <span class="confidence"
              >{Math.round(page.confidence)}% confidence
              <span class:low={page.confidence < 70} class="status-dot"
              ></span></span
            >
          </div>
          <div class:text-only={view === "text"} class="editor-body">
            {#if view === "split"}<div class="page-preview">
                <span class="pane-label">ORIGINAL</span><img
                  src={page.preview}
                  alt={`Original page ${page.number} of ${selected.file.name}`}
                />
              </div>{/if}
            <div class="text-pane">
              <label for="extracted-text" class="pane-label">TEXT</label
              ><textarea
                id="extracted-text"
                lang={options.language === "eng" ? "en" : "km"}
                spellcheck="false"
                aria-label={`Editable extracted text, page ${page.number}`}
                bind:value={page.text}
                placeholder="No text detected on this page. Try another model or resolution."
              ></textarea><span class="character-count"
                >{page.text.length.toLocaleString()} characters</span
              >
            </div>
          </div>
          {#if page.originalText !== undefined}
            <div class="review-note">
              <Icon name="AlertCircle" size={14} /><span
                >OCR corrections applied. Check against the original page.</span
              ><button
                class="text-button"
                disabled={page.text === page.originalText}
                onclick={() => {
                  page.text = page.originalText!;
                }}>Restore original OCR</button
              >
            </div>
          {/if}
          {#if page.reviewWords?.length}
            <div class="review-note"><Icon name="AlertCircle" size={14} /><span>Check possible misread words: {page.reviewWords.join(', ')}. Compare with the original page.</span></div>
          {/if}
          {#if page.confidence < 70}<div class="review-note">
              <Icon name="AlertCircle" size={14} />Low confidence. Check the
              text against the original.
            </div>{/if}
        {/if}
      </section>
    {/if}

    <div id="about" hidden={activePage !== "about" || showSettings}>
      <About />
    </div>
  </main>
  <footer class="site-footer">
    <span>Core</span><span aria-hidden="true">•</span><a href="#about" onclick={() => { showSettings = false; activePage = "about"; }}>About Core</a><span aria-hidden="true">•</span><a
      href="/source.tar.gz"
      download>Source code</a
    ><span aria-hidden="true">•</span><a
      href="https://github.com/VERT-sh/VERT"
      target="_blank"
      rel="noreferrer">UI from VERT</a
    >
  </footer>
</div>
