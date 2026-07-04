<script lang="ts">
	import { goto } from '$app/navigation';
	// /admin/settings has no content of its own — send to the first tab.
	$effect(() => {
		goto('/admin/settings/general', { replaceState: true });
	});
</script>
