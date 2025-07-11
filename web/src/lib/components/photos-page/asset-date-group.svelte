<script lang="ts">
  import Thumbnail from '$lib/components/assets/thumbnail/thumbnail.svelte';
  import Icon from '$lib/components/elements/icon.svelte';
  import type { MonthGroup } from '$lib/managers/timeline-manager/month-group.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { assetSnapshot, assetsSnapshot } from '$lib/managers/timeline-manager/utils.svelte';
  import type { AssetInteraction } from '$lib/stores/asset-interaction.svelte';
  import { isSelectingAllAssets } from '$lib/stores/assets-store.svelte';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { navigate } from '$lib/utils/navigation';

  import { mdiCheckCircle, mdiCircleOutline } from '@mdi/js';

  import { flip } from 'svelte/animate';
  import { fly, scale } from 'svelte/transition';

  let { isUploading } = uploadAssetsStore;

  interface Props {
    isSelectionMode: boolean;
    singleSelect: boolean;
    withStacked: boolean;
    showArchiveIcon: boolean;
    monthGroup: MonthGroup;
    timelineManager: TimelineManager;
    assetInteraction: AssetInteraction;

    onSelect: ({ title, assets }: { title: string; assets: TimelineAsset[] }) => void;
    onSelectAssets: (asset: TimelineAsset) => void;
    onSelectAssetCandidates: (asset: TimelineAsset | null) => void;
    onScrollCompensation: (compensation: { heightDelta?: number; scrollTop?: number }) => void;
  }

  let {
    isSelectionMode,
    singleSelect,
    withStacked,
    showArchiveIcon,
    monthGroup = $bindable(),
    assetInteraction,
    timelineManager,
    onSelect,
    onSelectAssets,
    onSelectAssetCandidates,
    onScrollCompensation,
  }: Props = $props();

  let isMouseOverGroup = $state(false);
  let hoveredDayGroup = $state();

  const transitionDuration = $derived.by(() =>
    monthGroup.timelineManager.suspendTransitions && !$isUploading ? 0 : 150,
  );
  const scaleDuration = $derived(transitionDuration === 0 ? 0 : transitionDuration + 100);
  const onClick = (
    timelineManager: TimelineManager,
    assets: TimelineAsset[],
    groupTitle: string,
    asset: TimelineAsset,
  ) => {
    if (isSelectionMode || assetInteraction.selectionActive) {
      assetSelectHandler(timelineManager, asset, assets, groupTitle);
      return;
    }
    void navigate({ targetRoute: 'current', assetId: asset.id });
  };

  const handleSelectGroup = (title: string, assets: TimelineAsset[]) => onSelect({ title, assets });

  const assetSelectHandler = (
    timelineManager: TimelineManager,
    asset: TimelineAsset,
    assetsInDayGroup: TimelineAsset[],
    groupTitle: string,
  ) => {
    onSelectAssets(asset);

    // Check if all assets are selected in a group to toggle the group selection's icon
    let selectedAssetsInGroupCount = assetsInDayGroup.filter((asset) =>
      assetInteraction.hasSelectedAsset(asset.id),
    ).length;

    // if all assets are selected in a group, add the group to selected group
    if (selectedAssetsInGroupCount == assetsInDayGroup.length) {
      assetInteraction.addGroupToMultiselectGroup(groupTitle);
    } else {
      assetInteraction.removeGroupFromMultiselectGroup(groupTitle);
    }

    if (timelineManager.assetCount == assetInteraction.selectedAssets.length) {
      isSelectingAllAssets.set(true);
    } else {
      isSelectingAllAssets.set(false);
    }
  };

  const assetMouseEventHandler = (groupTitle: string, asset: TimelineAsset | null) => {
    // Show multi select icon on hover on date group
    hoveredDayGroup = groupTitle;

    if (assetInteraction.selectionActive) {
      onSelectAssetCandidates(asset);
    }
  };

  function filterIntersecting<R extends { intersecting: boolean }>(intersectable: R[]) {
    return intersectable.filter((int) => int.intersecting);
  }

  $effect.root(() => {
    if (timelineManager.scrollCompensation.monthGroup === monthGroup) {
      onScrollCompensation(timelineManager.scrollCompensation);
      timelineManager.clearScrollCompensation();
    }
  });
</script>

{#each filterIntersecting(monthGroup.dayGroups) as dayGroup, groupIndex (dayGroup.day)}
  {@const absoluteWidth = dayGroup.left}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class={[
      { 'transition-all': !monthGroup.timelineManager.suspendTransitions },
      !monthGroup.timelineManager.suspendTransitions && `delay-${transitionDuration}`,
    ]}
    data-group
    style:position="absolute"
    style:transform={`translate3d(${absoluteWidth}px,${dayGroup.top}px,0)`}
    onmouseenter={() => {
      isMouseOverGroup = true;
      assetMouseEventHandler(dayGroup.groupTitle, null);
    }}
    onmouseleave={() => {
      isMouseOverGroup = false;
      assetMouseEventHandler(dayGroup.groupTitle, null);
    }}
  >
    <!-- Date group title -->
    <div
      class="flex pt-7 pb-5 max-md:pt-5 max-md:pb-3 h-6 place-items-center text-xs font-medium text-immich-fg dark:text-immich-dark-fg md:text-sm"
      style:width={dayGroup.width + 'px'}
    >
      {#if !singleSelect && ((hoveredDayGroup === dayGroup.groupTitle && isMouseOverGroup) || assetInteraction.selectedGroup.has(dayGroup.groupTitle))}
        <div
          transition:fly={{ x: -24, duration: 200, opacity: 0.5 }}
          class="inline-block pe-2 hover:cursor-pointer"
          onclick={() => handleSelectGroup(dayGroup.groupTitle, assetsSnapshot(dayGroup.getAssets()))}
          onkeydown={() => handleSelectGroup(dayGroup.groupTitle, assetsSnapshot(dayGroup.getAssets()))}
        >
          {#if assetInteraction.selectedGroup.has(dayGroup.groupTitle)}
            <Icon path={mdiCheckCircle} size="24" class="text-primary" />
          {:else}
            <Icon path={mdiCircleOutline} size="24" color="#757575" />
          {/if}
        </div>
      {/if}

      <span class="w-full truncate first-letter:capitalize" title={dayGroup.groupTitle}>
        {dayGroup.groupTitle}
      </span>
    </div>

    <!-- Image grid -->
    <div
      data-image-grid
      class="relative overflow-clip"
      style:height={dayGroup.height + 'px'}
      style:width={dayGroup.width + 'px'}
    >
      {#each filterIntersecting(dayGroup.viewerAssets) as viewerAsset (viewerAsset.id)}
        {@const position = viewerAsset.position!}
        {@const asset = viewerAsset.asset!}

        <!-- {#if viewerAsset.intersecting} -->
        <!-- note: don't remove data-asset-id - its used by web e2e tests -->
        <div
          data-asset-id={asset.id}
          class="absolute"
          style:top={position.top + 'px'}
          style:left={position.left + 'px'}
          style:width={position.width + 'px'}
          style:height={position.height + 'px'}
          out:scale|global={{ start: 0.1, duration: scaleDuration }}
          animate:flip={{ duration: transitionDuration }}
        >
          <Thumbnail
            showStackedIcon={withStacked}
            {showArchiveIcon}
            {asset}
            {groupIndex}
            onClick={(asset) => onClick(timelineManager, dayGroup.getAssets(), dayGroup.groupTitle, asset)}
            onSelect={(asset) => assetSelectHandler(timelineManager, asset, dayGroup.getAssets(), dayGroup.groupTitle)}
            onMouseEvent={() => assetMouseEventHandler(dayGroup.groupTitle, assetSnapshot(asset))}
            selected={assetInteraction.hasSelectedAsset(asset.id) ||
              dayGroup.monthGroup.timelineManager.albumAssets.has(asset.id)}
            selectionCandidate={assetInteraction.hasSelectionCandidate(asset.id)}
            disabled={dayGroup.monthGroup.timelineManager.albumAssets.has(asset.id)}
            thumbnailWidth={position.width}
            thumbnailHeight={position.height}
          />
        </div>
        <!-- {/if} -->
      {/each}
    </div>
  </section>
{/each}

<style>
  section {
    contain: layout paint style;
  }
  [data-image-grid] {
    user-select: none;
  }
</style>
