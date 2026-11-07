<script lang="ts">
  import { Upload, RefreshCw, Trash2, ScanText, Settings2, Sun, Moon, ChevronDown, ArrowUpRight, ArrowRight, Plus, X, FileText, Image, File, Check, LoaderCircle, Download, Copy, ChevronLeft, ChevronRight, RotateCcw, ShieldCheck, SlidersHorizontal, AlertCircle, StopCircle, CheckCheck } from '@lucide/svelte';
  let { name, size = 20, strokeWidth = 1.7 }: { name: string; size?: number; strokeWidth?: number } = $props();
  const icons: Record<string, typeof Upload> = { Upload, RefreshCw, Trash2, ScanText, Settings2, Sun, Moon, ChevronDown, ArrowUpRight, ArrowRight, Plus, X, FileText, Image, File, Check, LoaderCircle, Download, Copy, ChevronLeft, ChevronRight, RotateCcw, ShieldCheck, SlidersHorizontal, AlertCircle, StopCircle, CheckCheck };
  const Component = $derived(icons[name] ?? File);
</script>
<Component {size} {strokeWidth} aria-hidden="true" />
