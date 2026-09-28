export const countAnalyzedAutoVideoAssets = (generation: {
  assetIds: string[];
  assetAnalyses: Array<{assetId: string}>;
  assetCheckpoints?: Array<{assetId: string; visualAnalysis: {status: string}}>;
  steps: Array<{name: string; status: string}>;
}) => {
  const expectedAssetIds = new Set(generation.assetIds);
  if (generation.steps.some((step) => step.name === 'visual_analysis' && step.status === 'completed')) {
    return expectedAssetIds.size;
  }

  const completedAssetIds = new Set<string>();
  for (const analysis of generation.assetAnalyses) {
    if (expectedAssetIds.has(analysis.assetId)) completedAssetIds.add(analysis.assetId);
  }
  for (const checkpoint of generation.assetCheckpoints ?? []) {
    if (checkpoint.visualAnalysis.status === 'completed' && expectedAssetIds.has(checkpoint.assetId)) {
      completedAssetIds.add(checkpoint.assetId);
    }
  }
  return completedAssetIds.size;
};
