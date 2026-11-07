<!-- Adapted from VERT's functional/Uploader.svelte (257bcb3), AGPL-3.0. -->
<script lang="ts">
  import { Upload } from '@lucide/svelte';
  import Panel from './Panel.svelte';

  let { onbrowse, onfiles, compact = false, workspace = false }: {
    onbrowse: () => void;
    onfiles: (files: FileList | File[]) => void;
    compact?: boolean;
    workspace?: boolean;
  } = $props();
  let dragging = $state(false);
  let dragDepth = 0;
  function drag(event: DragEvent) {
    event.preventDefault();
    if (event.type === 'dragenter') dragDepth++;
    if (event.type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
    dragging = dragDepth > 0;
  }
</script>

<button
  class="vert-uploader duration-200 hover:scale-105 active:scale-100"
  class:dragging
  class:compact
  class:workspace
  onclick={onbrowse}
  ondragenter={drag}
  ondragleave={drag}
  ondragover={(event) => event.preventDefault()}
  ondrop={(event) => { event.preventDefault(); dragging = false; dragDepth = 0; if (event.dataTransfer?.files) onfiles(event.dataTransfer.files); }}
>
  <Panel class="pointer-events-none flex h-full w-full flex-col items-center justify-center">
    <div class="flex h-16 w-16 items-center justify-center rounded-full bg-accent p-4">
      <Upload class="h-full w-full text-on-accent" />
    </div>
    <h2 class="mt-4 text-center text-2xl font-semibold">{dragging ? 'Drop to add files' : compact ? 'Drop, paste or click to add files' : 'Drop, paste or click to extract'}</h2>
    <p class="paste-hint">Paste images with Ctrl+V or ⌘V</p>
  </Panel>
</button>

<style>
  .paste-hint {
    margin: 8px 16px 0;
    color: var(--fg-muted);
    font-size: 13px;
    font-weight: 400;
    line-height: 1.5;
    text-align: center;
  }
</style>
