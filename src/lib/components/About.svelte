<script lang="ts">
  import { Info, FileText, Languages, ShieldCheck } from '@lucide/svelte';
</script>

    <section class="about-hero" aria-labelledby="about-title">
      <h1 id="about-title" class="about-title"><Info aria-hidden="true" /><span>About</span></h1>
      <p class="about-intro">Core is a Khmer OCR tool that turns PDFs, scanned documents, and images into editable Unicode text. Extract Khmer, English, or both, then review, copy, and download the words you need.</p>
    </section>

    <section class="about-section" aria-labelledby="features-title">
      <h2 id="features-title">Less retyping. More useful text.</h2>
      <p class="section-intro">Make scanned pages easier to edit, quote, and reuse in your own documents.</p>
      <div class="about-cards">
        <article class="about-card">
          <FileText size={28} aria-hidden="true" />
          <h3>PDFs and images to text</h3>
          <p>Extract text from scanned PDFs and PNG, JPEG, WebP, or BMP images. DOC, DOCX, ODT, and RTF conversion is also available when document rendering is enabled on the server.</p>
        </article>
        <article class="about-card">
          <Languages size={28} aria-hidden="true" />
          <h3>Khmer and English OCR</h3>
          <p>Choose Khmer, English, or a mixed-language mode. Core produces Unicode text you can edit and copy, with accurate and fast recognition options for different tasks.</p>
        </article>
        <article class="about-card">
          <ShieldCheck size={28} aria-hidden="true" />
          <h3>Review before you reuse</h3>
          <p>Compare extracted text with a preview of each page. Edit the result, check low-confidence passages, and export your corrections as a UTF-8 text file.</p>
        </article>
      </div>
    </section>

    <section class="about-section about-workflow" aria-labelledby="workflow-title">
      <div>
        <p class="eyebrow">FROM SCAN TO TEXT</p>
        <h2 id="workflow-title">How Core works</h2>
        <p>OCR, or optical character recognition, reads the shapes of characters in an image and turns them into text. Core uses it to make scanned Khmer and English pages editable.</p>
      </div>
      <ol>
        <li><h3>Add your files</h3><p>Drop in PDFs, images, or supported documents. You can queue up to 20 files, with a 50 MB limit per file and up to 200 pages per PDF.</p></li>
        <li><h3>Choose your settings</h3><p>Select a language and recognition quality. Scan enhancement can improve faint or slightly tilted scans; PDF resolution and layout settings give you more control.</p></li>
        <li><h3>Extract, review, and export</h3><p>Run OCR, compare each result with the original page, and make corrections. Copy the text or download individual results or the completed batch.</p></li>
      </ol>
    </section>

    <section class="about-section privacy-panel" aria-labelledby="privacy-title">
      <p class="eyebrow">YOUR FILES, EXPLAINED</p>
      <h2 id="privacy-title">Where your documents are processed</h2>
      <p>PDF and image OCR runs in your browser. Office documents are uploaded to the server hosting Core so they can be rendered to PDF; recognition then runs in your browser. Core has no accounts, analytics, or third-party OCR service calls.</p>
      <p>Your workspace and extracted results stay in memory and clear when you refresh. PDF page images use temporary browser storage during conversion, and OCR language models may be cached for reuse. Closing a tab unexpectedly can leave temporary images until browser site data is cleared. Temporary Office-rendering files are removed from the server after conversion finishes or fails.</p>
    </section>

    <section class="about-section about-faq" aria-labelledby="faq-title">
      <h2 id="faq-title">Questions about Core</h2>
      <details open><summary>What can I use Khmer OCR for?</summary><p>Core helps students, researchers, and anyone working with scanned Khmer material extract text from books, study notes, reports, and document images. You can then correct the text and use it in an editor or another document.</p></details>
      <details><summary>Can Core read a scanned PDF without selectable text?</summary><p>Yes. Core renders PDF pages as images and reads them with OCR, so a PDF does not need an existing text layer. Password-protected PDFs must be unlocked before conversion.</p></details>
      <details><summary>Will the extracted text be completely accurate?</summary><p>OCR can make mistakes, especially with blurred images, unusual fonts, complex layouts, or faint scans. Clear, straight scans usually give better results. Always compare important passages, names, and numbers with the original; confidence scores are a guide, not a guarantee of accuracy.</p></details>
      <details><summary>Can I keep the original document formatting?</summary><p>Core exports plain text. It provides page previews and paragraph formatting for review, but it does not recreate the original document’s fonts, tables, or page layout in an editable Word file.</p></details>
      <details><summary>Is Core open source?</summary><p>Core is distributed under the GNU AGPL v3. Its interface adapts work from <a href="https://github.com/VERT-sh/VERT">VERT</a>. You can <a href="/source.tar.gz" download>download Core’s source code</a>, including its license and attribution notices.</p></details>
    </section>


<style>
  .about-hero { max-width: 820px; padding: 32px 0 48px; }
  .about-title {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 24px;
    color: var(--fg);
  }
  .about-title :global(svg) {
    width: 1em;
    height: 1em;
    stroke-width: 2;
  }
  .eyebrow { color: var(--fg-accent); font-size: 12px; letter-spacing: .16em; font-weight: 600; margin-bottom: 20px; }
  .about-intro { max-width: 720px; font-size: 21px; line-height: 1.65; }
  p, li { font-weight: 400; }
  .about-section { padding: 56px 0; border-top: 1px solid var(--line); }
  h2 { font-size: clamp(27px, 3.5vw, 38px); letter-spacing: -.025em; line-height: 1.2; margin-bottom: 18px; }
  h3 { font-size: 21px; line-height: 1.35; margin-bottom: 12px; }
  .section-intro, .about-section p { color: var(--fg-muted); line-height: 1.8; }
  .about-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 30px; }
  .about-card { padding: 28px; border-radius: 20px; background: var(--bg-panel); box-shadow: var(--shadow-panel); }
  .about-card :global(svg) { color: var(--accent); margin-bottom: 24px; }
  .about-workflow { display: grid; grid-template-columns: 1fr 1.2fr; gap: 80px; }
  .about-workflow ol { list-style: decimal; padding-left: 28px; }
  .about-workflow li { padding-left: 12px; margin-bottom: 28px; }
  .about-workflow li:last-child { margin-bottom: 0; }
  .about-workflow li::marker { color: var(--accent); font-family: var(--font-display); font-size: 22px; }
  .privacy-panel { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 24px; padding: 36px; margin: 16px 0 56px; }
  .privacy-panel p + p { margin-top: 16px; }
  .about-faq details { padding: 22px 0; border-bottom: 1px solid var(--line); }
  .about-faq summary { cursor: pointer; font-size: 18px; }
  .about-faq details p { padding-top: 14px; max-width: 850px; }
  @media (max-width: 760px) {
    .about-hero { padding: 24px 0 36px; }
    .about-intro { font-size: 18px; }
    .about-cards, .about-workflow { grid-template-columns: 1fr; gap: 20px; }
    .about-section { padding: 36px 0; }
    .privacy-panel { padding: 24px; margin-bottom: 36px; }
  }
</style>
