<script lang="ts">
	import { page } from '$app/state';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import {
		UploadCloud,
		FileText,
		CheckCircle2,
		ChevronLeft,
		AlertCircle,
		X,
		Loader2,
		XCircle
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, Button } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { Document } from '@insightlibrary/schemas';

	// Dynamic route param — always present when this route matches.
	const folderId = $derived(page.params.id!);
	const qc = useQueryClient();

	// Fetch folder to label the SSOT-comparison note; fall back to the raw id.
	const folderQuery = $derived(
		createQuery({ queryKey: ['folder', folderId], queryFn: () => api.getFolder(folderId) })
	);
	const folderName = $derived($folderQuery.data?.folder.name ?? 'this folder');

	type UploadStatus = 'queued' | 'presigning' | 'uploading' | 'creating' | 'done' | 'error';
	type QueuedFile = {
		id: string;
		file: File;
		status: UploadStatus;
		progress: number;
		error?: string;
	};

	let files = $state<QueuedFile[]>([]);
	let dragging = $state(false);
	let inputEl: HTMLInputElement;
	let submitting = $state(false);

	const ontologies = [
		'Medical (Disease, Anatomy, Pharmacology, etc.)',
		'Legal (Law, Statute, Case, Precedent, etc.)',
		'Enterprise SOP (Policy, Procedure, Role, etc.)',
		'General / Auto-Detect'
	];
	let ontology = $state(ontologies[0]);

	const pipelineOptions = [
		'Run Optical Character Recognition (OCR)',
		'Semantic Chunking & Embedding',
		'Delta Knowledge Extraction (Merge to SSOT)'
	];

	const ACCEPT = '.pdf,.epub,.docx,.txt';

	function extToType(name: string): Document['type'] {
		const ext = name.split('.').pop()?.toLowerCase();
		if (ext === 'epub') return 'epub';
		if (ext === 'docx') return 'docx';
		return 'pdf';
	}

	function addFiles(list: FileList | null) {
		if (!list) return;
		const next = Array.from(list).map((file) => ({
			id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
			file,
			status: 'queued' as UploadStatus,
			progress: 0
		}));
		files = [...files, ...next];
	}

	function removeFile(id: string) {
		files = files.filter((f) => f.id !== id);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		addFiles(e.dataTransfer?.files ?? null);
	}

	function fmtSize(bytes: number) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function patch(id: string, changes: Partial<QueuedFile>) {
		files = files.map((f) => (f.id === id ? { ...f, ...changes } : f));
	}

	// Demonstrates the real ingestion flow: presign an upload target, PUT the
	// bytes, then register the document via createDocument.
	async function processFile(item: QueuedFile) {
		try {
			patch(item.id, { status: 'presigning', progress: 10 });
			const presign = await api.presignUpload({
				filename: item.file.name,
				contentType: item.file.type || 'application/octet-stream',
				folderId
			});

			patch(item.id, { status: 'uploading', progress: 40 });
			await fetch(presign.url, {
				method: presign.method ?? 'PUT',
				body: item.file,
				headers: { 'Content-Type': item.file.type || 'application/octet-stream' }
			});

			patch(item.id, { status: 'creating', progress: 80 });
			await api.createDocument({
				folderId,
				title: item.file.name.replace(/\.[^.]+$/, ''),
				type: extToType(item.file.name),
				pages: 0,
				storageKey: presign.key
			});

			patch(item.id, { status: 'done', progress: 100 });
		} catch (err) {
			patch(item.id, {
				status: 'error',
				progress: 100,
				error: err instanceof Error ? err.message : 'Upload failed'
			});
		}
	}

	async function uploadAll() {
		const pending = files.filter((f) => f.status === 'queued' || f.status === 'error');
		if (pending.length === 0) return;
		submitting = true;
		for (const item of pending) {
			await processFile(item);
		}
		submitting = false;
		qc.invalidateQueries({ queryKey: ['folder', folderId] });
		qc.invalidateQueries({ queryKey: ['documents'] });
	}

	const statusMeta: Record<UploadStatus, { label: string; tone: string }> = {
		queued: { label: 'Queued', tone: 'text-zinc-500' },
		presigning: { label: 'Preparing', tone: 'text-amber-400' },
		uploading: { label: 'Uploading', tone: 'text-indigo-400' },
		creating: { label: 'Registering', tone: 'text-indigo-400' },
		done: { label: 'Complete', tone: 'text-emerald-400' },
		error: { label: 'Failed', tone: 'text-rose-400' }
	};

	const hasPending = $derived(files.some((f) => f.status === 'queued' || f.status === 'error'));
</script>

<input
	bind:this={inputEl}
	type="file"
	accept={ACCEPT}
	multiple
	class="hidden"
	onchange={(e) => {
		addFiles(e.currentTarget.files);
		e.currentTarget.value = '';
	}}
/>

<div class="mx-auto flex min-h-[calc(100vh-8rem)] max-w-2xl flex-col justify-center py-4">
	<div class="mb-6">
		<a
			href="/folders/{folderId}"
			class="flex w-fit items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
		>
			<ChevronLeft class="h-4 w-4" /> Back to Folder
		</a>
	</div>

	<Card class="overflow-hidden p-8">
		<div class="mb-8 text-center">
			<div
				class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-indigo-500/20 bg-indigo-500/10"
			>
				<UploadCloud class="h-8 w-8 text-indigo-400" />
			</div>
			<h1 class="mb-2 text-2xl font-bold text-zinc-100">Upload Source Material</h1>
			<p class="text-sm text-zinc-400">
				Add textbooks, PDFs, or research notes to automatically extract claims, build the knowledge
				graph, and merge into SSOT topics.
			</p>
		</div>

		<!-- Drop zone -->
		<button
			type="button"
			onclick={() => inputEl.click()}
			ondragover={(e) => {
				e.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={onDrop}
			class={cn(
				'group flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-all',
				dragging
					? 'border-indigo-500/70 bg-indigo-500/10'
					: 'border-zinc-700 bg-zinc-900/50 hover:border-indigo-500/50 hover:bg-indigo-500/5'
			)}
		>
			<FileText
				class={cn(
					'mb-4 h-10 w-10 transition-colors',
					dragging ? 'text-indigo-400' : 'text-zinc-600 group-hover:text-indigo-400'
				)}
			/>
			<p class="mb-1 font-medium text-zinc-300">Click to browse or drag documents here</p>
			<p class="text-xs text-zinc-500">Supports PDF, EPUB, DOCX, TXT (Max 500MB per file)</p>
		</button>

		<!-- File list -->
		{#if files.length > 0}
			<div class="mt-6 space-y-2" in:fade={{ duration: 150 }}>
				{#each files as item (item.id)}
					{@const meta = statusMeta[item.status]}
					<div
						in:fly={{ y: 6, duration: 150 }}
						class="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
					>
						<div class="rounded bg-zinc-800/80 p-2 text-zinc-400">
							{#if item.status === 'presigning' || item.status === 'uploading' || item.status === 'creating'}
								<Loader2 class="h-4 w-4 animate-spin text-indigo-400" />
							{:else if item.status === 'done'}
								<CheckCircle2 class="h-4 w-4 text-emerald-400" />
							{:else if item.status === 'error'}
								<XCircle class="h-4 w-4 text-rose-400" />
							{:else}
								<FileText class="h-4 w-4" />
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex items-center justify-between gap-2">
								<span class="truncate text-sm text-zinc-200">{item.file.name}</span>
								<span class="shrink-0 font-mono text-[11px] text-zinc-500">{fmtSize(item.file.size)}</span>
							</div>
							<div class="mt-1.5 flex items-center gap-2">
								<div class="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
									<div
										class={cn(
											'h-full rounded-full transition-all duration-300',
											item.status === 'error' ? 'bg-rose-500' : 'bg-indigo-500'
										)}
										style="width: {item.progress}%"
									></div>
								</div>
								<span class={cn('shrink-0 text-[11px]', meta.tone)}>{meta.label}</span>
							</div>
							{#if item.error}
								<p class="mt-1 text-[11px] text-rose-400/80">{item.error}</p>
							{/if}
						</div>
						{#if item.status !== 'done'}
							<button
								onclick={() => removeFile(item.id)}
								class="text-zinc-500 transition-colors hover:text-rose-400"
								title="Remove"
							>
								<X class="h-4 w-4" />
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Processing config -->
		<div class="mt-8 space-y-4">
			<h3 class="text-sm font-semibold text-zinc-200">Processing Configuration</h3>
			<div class="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
				<div class="space-y-2">
					<label
						for="ontology"
						class="block text-xs font-medium tracking-wider text-zinc-400 uppercase"
						>Target Ontology</label
					>
					<select
						id="ontology"
						bind:value={ontology}
						class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
					>
						{#each ontologies as opt (opt)}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
					<p class="text-[10px] text-zinc-500">
						Guides the AI in structured claim classification and graph extraction.
					</p>
				</div>

				<div class="space-y-3 border-t border-zinc-800 pt-3">
					{#each pipelineOptions as opt (opt)}
						<div class="flex items-center gap-3">
							<CheckCircle2 class="h-4 w-4 shrink-0 text-emerald-400" />
							<span class="text-sm text-zinc-300">{opt}</span>
						</div>
					{/each}
				</div>

				<div class="mt-2 flex items-start gap-3 border-t border-zinc-800 pt-3">
					<AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
					<p class="text-xs leading-relaxed text-zinc-400">
						Extracted topics will be compared against existing SSOTs in
						<span class="font-medium text-zinc-300">{folderName}</span>. Contradictions will be
						sent to the governance review queue.
					</p>
				</div>
			</div>
		</div>

		<div class="mt-8 flex justify-end">
			<Button size="lg" disabled={!hasPending || submitting} onclick={uploadAll}>
				{#if submitting}
					<Loader2 class="h-4 w-4 animate-spin" /> Processing…
				{:else}
					<UploadCloud class="h-4 w-4" /> Upload & Process
				{/if}
			</Button>
		</div>
	</Card>
</div>
