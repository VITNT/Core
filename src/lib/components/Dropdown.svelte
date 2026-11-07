<script lang="ts" generics="T extends string | number">
  import { tick } from 'svelte';
  import { ChevronDown, Check } from '@lucide/svelte';

  let { value = $bindable(), options, label, disabled = false, inline = false }: {
    value: T;
    options: { value: T; label: string }[];
    label: string;
    disabled?: boolean;
    inline?: boolean;
  } = $props();
  const id = $props.id();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let open = $state(false);
  let highlighted = $state(0);
  let above = $state(false);
  let menuHeight = $state(300);
  let search = '';
  let searchTime = 0;
  const selected = $derived(options.find((option) => option.value === value));

  function positionMenu() {
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 16;
    const aboveSpace = rect.top - 16;
    above = below < Math.min(options.length * 48 + 12, 300) && aboveSpace > below;
    menuHeight = Math.max(48, Math.min(300, above ? aboveSpace : below));
  }

  async function reveal(index = options.findIndex((option) => option.value === value)) {
    if (disabled || !options.length) return;
    positionMenu();
    highlighted = Math.max(0, index);
    open = true;
    await tick();
    scrollOption();
  }

  function scrollOption() {
    root.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index: number) {
    value = options[index].value;
    open = false;
    trigger.focus();
  }

  async function keydown(event: KeyboardEvent) {
    if (disabled) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) await reveal();
      else if (event.key === 'ArrowDown') highlighted = (highlighted + 1) % options.length;
      else if (event.key === 'ArrowUp') highlighted = (highlighted - 1 + options.length) % options.length;
      if (event.key === 'Home') highlighted = 0;
      if (event.key === 'End') highlighted = options.length - 1;
      await tick();
      scrollOption();
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(highlighted);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      open = false;
    } else if (event.key === 'Tab') {
      open = false;
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      search = now - searchTime > 700 ? event.key : search + event.key;
      searchTime = now;
      const index = options.findIndex((option) => option.label.toLowerCase().startsWith(search.toLowerCase()));
      if (index >= 0) {
        if (!open) await reveal(index);
        else highlighted = index;
        await tick();
        scrollOption();
      }
    }
  }

  $effect(() => { if (disabled) open = false; });
</script>

<svelte:window onpointerdown={(event) => { if (root && !root.contains(event.target as Node)) open = false; }} onresize={() => { if (open) positionMenu(); }} />

<div bind:this={root} class="custom-dropdown" class:inline class:open class:above>
  <button
    bind:this={trigger}
    class="dropdown-trigger"
    role="combobox"
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${id}-options`}
    aria-activedescendant={open ? `${id}-option-${highlighted}` : undefined}
    {disabled}
    onclick={() => { if (open) open = false; else void reveal(); }}
    onkeydown={keydown}
    onblur={() => { open = false; }}
  >
    <span>{selected?.label ?? 'Select'}</span><ChevronDown size={16} aria-hidden="true" />
  </button>
  {#if open}
    <div id={`${id}-options`} class="dropdown-options" role="listbox" aria-label={label} style:max-height={`${menuHeight}px`}>
      {#each options as option, index (option.value)}
        <div
          id={`${id}-option-${index}`}
          role="option"
          aria-selected={option.value === value}
          class="dropdown-option"
          class:highlighted={highlighted === index}
          data-index={index}
          tabindex="-1"
          onpointerdown={(event) => event.preventDefault()}
          onpointermove={() => { highlighted = index; }}
          onclick={() => choose(index)}
          onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') choose(index); }}
        >
          <span>{option.label}</span>{#if option.value === value}<Check size={16} aria-hidden="true" />{/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
