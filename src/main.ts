export {
  getAutoApproveEligibility,
  type AutoApproveEligibility,
  type AutoApproveInput,
} from './autoApprove';
export { removeImportOnlyChanges } from './childDiff';
export {
  defaultBranchNames,
  parseConfig,
  resolveConfig,
  type BranchNames,
  type ConfigError,
  type ResolvedConfig,
  type UmbrellaConfig,
} from './config';
export type { Exec, ExecResult } from './exec';
export type { FullPrInfo, PrInfo } from './github';
export {
  findUmbrellaBranch,
  formatChildBranch,
  formatSyncBranch,
  formatSyncName,
  formatUmbrellaBranch,
  getChildrenOf,
  getNextSyncBranchName,
  inferTitleFromName,
  isChildOf,
  normalizeBranchSegment,
  parseBranch,
  parseBranchStrict,
  parseSyncName,
  validateChildName,
  validateUmbrellaName,
  type NamingConfig,
  type NamingError,
  type ParsedBranch,
  type ParsedChild,
  type ParsedUmbrella,
  type SyncInfo,
} from './naming';
export {
  getDependencyChain,
  resolveCurrentBase,
  type CurrentBase,
  type DependencyChainResult,
} from './dependency';
export {
  addChildToUmbrellaBody,
  addParentLinkToChildBody,
  bodyLinksPr,
  childPrTemplate,
  CHILDREN_PRS_HEADING,
  findParentPr,
  syncPrTemplate,
  umbrellaPrTemplate,
  type FindParentPrError,
  type PrTemplate,
} from './prTemplates';
export { err, ok, type Err, type Ok, type Result } from './result';
export {
  parseMergedBranch,
  renderSyncDiffComment,
  type SyncBaseDiff,
  type SyncDiffContents,
  type SyncDiffMode,
  type SyncDiffResult,
  type SyncDiffSection,
} from './syncDiff';
export { buildTree, type UmbrellaTree, type UmbrellaTreeNode } from './tree';
export {
  createUmbrellaPrs,
  type CreatedPr,
  type CreateUmbrellaPrsOptions,
  type OpError,
  type OpErrorCode,
  type OpResult,
  type Tree,
  type TreeNode,
  type UmbrellaHooks,
  type UmbrellaPrs,
} from './umbrella';
export type {
  VerifyError,
  VerifyErrorCode,
  VerifyInput,
  VerifyResult,
  VerifyWarning,
  VerifyWarningCode,
} from './verify';
