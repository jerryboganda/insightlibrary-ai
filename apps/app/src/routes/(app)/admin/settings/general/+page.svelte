<script lang="ts">
	import { Save, AlertTriangle, UploadCloud, CheckCircle2, Loader2 } from '@lucide/svelte';
	import { fade, fly, scale } from 'svelte/transition';

	// Inline settings state — no dedicated tenant-config endpoint yet (prototype spec).
	let workspaceName = $state('InsightLibrary Corporate');
	let strictCitation = $state(true);
	let autoSsot = $state(true);
	let deleteConfirm = $state('');

	let isSaving = $state(false);
	let showSaved = $state(false);
	let isDeleting = $state(false);

	// Logo upload is client-side only for now (no asset endpoint yet). Selecting a
	// file reads it as a data URL for immediate preview; persistence is TBD.
	let logoInput = $state<HTMLInputElement | null>(null);
	let logoPreview = $state<string | null>(null);

	function pickLogo() {
		logoInput?.click();
	}

	function onLogoChange(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => (logoPreview = typeof reader.result === 'string' ? reader.result : null);
		reader.readAsDataURL(file);
	}

	function handleSave() {
		isSaving = true;
		setTimeout(() => {
			isSaving = false;
			showSaved = true;
			setTimeout(() => (showSaved = false), 3000);
		}, 1000);
	}

	const logoInitial = $derived(workspaceName.charAt(0).toUpperCase() || 'W');
	const canDelete = $derived(deleteConfirm === workspaceName);
</script>

<div class="relative max-w-4xl p-6 md:p-8">
	<header class="mb-8">
		<h1 class="text-2xl font-bold tracking-tight text-zinc-100">General Settings</h1>
		<p class="mt-1 text-sm text-zinc-400">
			Manage global configuration, branding, and defaults for your tenant.
		</p>
	</header>

	<div class="space-y-8">
		<!-- Workspace Identity -->
		<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800 shadow-sm">
			<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Workspace Identity</h2>
				<p class="mt-1 text-sm text-zinc-400">
					This organization name will be visible to all invited users.
				</p>
			</div>
			<div class="space-y-6 p-6">
				<div class="space-y-2">
					<label class="text-sm font-medium text-zinc-300" for="workspace-name">Workspace Name</label>
					<input
						id="workspace-name"
						type="text"
						bind:value={workspaceName}
						class="w-full max-w-md rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
					/>
				</div>

				<div class="space-y-2">
					<span class="text-sm font-medium text-zinc-300">Workspace Logo</span>
					<div class="flex items-center gap-6">
						<div
							class="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl font-bold text-white uppercase shadow-lg shadow-indigo-500/20"
						>
							{#if logoPreview}
								<img src={logoPreview} alt="Workspace logo preview" class="h-full w-full object-cover" />
							{:else}
								{logoInitial}
							{/if}
						</div>
						<input
							bind:this={logoInput}
							onchange={onLogoChange}
							type="file"
							accept="image/*"
							class="hidden"
						/>
						<button
							type="button"
							onclick={pickLogo}
							class="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/50 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
						>
							<UploadCloud class="h-4 w-4" /> Change Logo
						</button>
					</div>
				</div>
			</div>
		</section>

		<!-- Platform Defaults -->
		<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800 shadow-sm">
			<div class="border-b border-zinc-800 bg-zinc-900/30 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Platform Defaults</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Configure default behaviors for newly created folders and users.
				</p>
			</div>
			<div class="space-y-6 p-6">
				<div class="flex max-w-md items-start justify-between gap-4">
					<div>
						<h4 class="text-sm font-medium text-zinc-200">Strict Citation Mode by Default</h4>
						<p class="mt-0.5 text-xs leading-snug text-zinc-500">
							Require Copilot SDK agents to only answer using retrieved and verified citations.
						</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={strictCitation}
						aria-label="Strict citation mode"
						onclick={() => (strictCitation = !strictCitation)}
						class="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {strictCitation
							? 'border-indigo-500 bg-indigo-500'
							: 'border-zinc-700 bg-zinc-800'}"
					>
						<span
							class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {strictCitation
								? 'translate-x-[22px]'
								: 'translate-x-0.5'}"
						></span>
					</button>
				</div>

				<div class="flex max-w-md items-start justify-between gap-4 border-t border-zinc-800/50 pt-6">
					<div>
						<h4 class="text-sm font-medium text-zinc-200">Auto-Generate SSOT Topics</h4>
						<p class="mt-0.5 text-xs leading-snug text-zinc-500">
							Automatically compile single source of truth topics from new document uploads.
						</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autoSsot}
						aria-label="Auto-generate SSOT topics"
						onclick={() => (autoSsot = !autoSsot)}
						class="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors {autoSsot
							? 'border-indigo-500 bg-indigo-500'
							: 'border-zinc-700 bg-zinc-800'}"
					>
						<span
							class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform {autoSsot
								? 'translate-x-[22px]'
								: 'translate-x-0.5'}"
						></span>
					</button>
				</div>
			</div>
		</section>

		<!-- Action Bar -->
		<div class="relative flex justify-end pt-4 pb-12">
			{#if showSaved}
				<div
					in:fly={{ x: -20, duration: 250 }}
					out:fade={{ duration: 150 }}
					class="absolute top-6 right-[200px] flex items-center gap-2 text-sm font-medium text-emerald-400"
				>
					<CheckCircle2 class="h-4 w-4" />
					Configuration Saved
				</div>
			{/if}
			<button
				onclick={handleSave}
				disabled={isSaving}
				class="flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if isSaving}
					<Loader2 class="h-4 w-4 animate-spin" />
					Saving...
				{:else}
					<Save class="h-4 w-4" />
					Save Configuration
				{/if}
			</button>
		</div>

		<!-- Danger Zone -->
		<section class="mt-8 overflow-hidden rounded-xl border border-rose-500/20 bg-rose-500/5 shadow-sm">
			<div class="border-b border-rose-500/20 bg-rose-500/5 p-6">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-rose-400">
					<AlertTriangle class="h-5 w-5" /> Danger Zone
				</h2>
				<p class="mt-1 text-sm text-zinc-500">Irreversible and destructive workspace actions.</p>
			</div>
			<div class="flex flex-col justify-between gap-6 p-6 sm:flex-row sm:items-center">
				<div>
					<h4 class="text-sm font-medium text-zinc-200">Delete Workspace</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Permanently remove your workspace and all its data from InsightLibrary AI.
					</p>
				</div>
				<button
					onclick={() => {
						isDeleting = true;
						deleteConfirm = '';
					}}
					class="rounded-md border border-rose-500/30 bg-rose-500/10 px-6 py-2.5 text-sm font-medium whitespace-nowrap text-rose-400 transition-all hover:bg-rose-500 hover:text-white"
				>
					Delete Workspace
				</button>
			</div>
		</section>
	</div>
</div>

<!-- Delete Confirmation Modal -->
{#if isDeleting}
	<div
		transition:fade={{ duration: 150 }}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) isDeleting = false;
		}}
		role="presentation"
	>
		<div
			transition:scale={{ duration: 180, start: 0.95, opacity: 0 }}
			class="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div class="border-b border-zinc-800 bg-rose-500/5 p-6">
				<h2 class="flex items-center gap-2 text-xl font-bold text-rose-400">
					<AlertTriangle class="h-5 w-5" />
					Delete Workspace
				</h2>
				<p class="mt-2 text-sm text-zinc-400">
					This action is permanent and cannot be undone. All data, users, and settings will be lost.
				</p>
			</div>
			<div class="space-y-4 p-6">
				<label class="text-sm text-zinc-300" for="delete-confirm">
					Please type
					<span class="rounded bg-rose-500/10 px-1 font-mono font-bold text-rose-400"
						>{workspaceName}</span
					> to confirm.
				</label>
				<input
					id="delete-confirm"
					type="text"
					bind:value={deleteConfirm}
					placeholder="Workspace Name"
					class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 transition-colors focus:border-rose-500/50 focus:outline-none"
				/>
			</div>
			<div class="flex gap-3 p-6 pt-0">
				<button
					onclick={() => (isDeleting = false)}
					class="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					Cancel
				</button>
				<button
					disabled={!canDelete}
					onclick={() => (isDeleting = false)}
					class="flex-1 rounded-md bg-rose-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Permanently Delete
				</button>
			</div>
		</div>
	</div>
{/if}
