<!-- Adapted from VERT's Navbar/Base.svelte (257bcb3), AGPL-3.0. -->
<script lang="ts">
  import Panel from './Panel.svelte';
  import { Upload, RefreshCw, Settings, Info, Moon, Sun } from '@lucide/svelte';

  let { count, active, light, onupload, onconvert, onsettings, onabout, ontheme }: {
    count: number;
    active: 'upload' | 'convert' | 'settings' | 'about';
    light: boolean;
    onupload: () => void;
    onconvert: () => void;
    onsettings: () => void;
    onabout: () => void;
    ontheme: () => void;
  } = $props();
</script>

<nav class="vert-navigation" aria-label="Main navigation">
  <Panel class="vert-navbar relative flex h-20 items-center gap-3">
    <a class="vert-wordmark" href="/" aria-label="Core home" onclick={(event) => { event.preventDefault(); onupload(); }}>Core</a>
    <div class="vert-nav-tabs">
    <span class="vert-nav-indicator" style:transform={`translateX(${active === 'upload' ? 0 : active === 'convert' ? 100 : active === 'settings' ? 200 : 300}%)`} aria-hidden="true"></span>
    <button class:nav-active={active === 'upload'} class="vert-nav-link" aria-current={active === 'upload' ? 'page' : undefined} onclick={onupload} aria-label="Upload files">
      <Upload size={24} /><span>Upload</span>
    </button>
    <button class:nav-active={active === 'convert'} class="vert-nav-link" aria-current={active === 'convert' ? 'page' : undefined} onclick={onconvert} aria-label="View extraction workspace">
      <span class="relative"><RefreshCw size={24} />{#if count}<span class="vert-nav-badge">{count}</span>{/if}</span><span>Extract</span>
    </button>
    <button class:nav-active={active === 'settings'} class="vert-nav-link" aria-expanded={active === 'settings'} aria-controls="settings" onclick={onsettings} aria-label="Settings">
      <Settings size={24} /><span>Settings</span>
    </button>
    <button class:nav-active={active === 'about'} class="vert-nav-link" aria-current={active === 'about' ? 'page' : undefined} aria-controls="about" onclick={onabout} aria-label="About Core">
      <Info size={24} /><span>About</span>
    </button>
    </div>
    <span class="vert-nav-separator"></span>
    <button class="vert-theme-button" onclick={ontheme} aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'}>
      {#if light}<Sun size={24} />{:else}<Moon size={24} />{/if}
    </button>
  </Panel>
</nav>
