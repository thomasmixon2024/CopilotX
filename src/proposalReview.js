'use strict';

const vscode = require('vscode');
const { applyProposal } = require('./core/proposals');

const PROPOSAL_SCHEME = 'copilotx-proposal';
const proposals = new Map();

class ProposalContentProvider {
  provideTextDocumentContent(uri) {
    // "-empty" sentinels render as the empty left side of a new-file diff;
    // they are derived from the stored proposal, never stored separately.
    if (uri.query.endsWith('-empty')) return '';
    const proposal = proposals.get(uri.query);
    return proposal ? proposal.proposed : '';
  }
}

function registerProposalReview(context) {
  const provider = new ProposalContentProvider();
  const registration = vscode.workspace.registerTextDocumentContentProvider(
    PROPOSAL_SCHEME,
    provider
  );
  context.subscriptions.push(registration);
}

function storeProposal(proposal) {
  proposals.set(proposal.id, proposal);
  return proposal;
}

function getProposal(id) {
  return proposals.get(id);
}

function listPendingProposals() {
  return [...proposals.values()];
}

async function reviewProposal(id) {
  const proposal = proposals.get(id);
  if (!proposal) {
    vscode.window.showWarningMessage('CopilotX: proposal no longer available.');
    return;
  }
  const originalUri = proposal.created
    ? vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: proposal.path, query: `${proposal.id}-empty` })
    : vscode.Uri.file(proposal.path);
  const proposedUri = vscode.Uri.from({
    scheme: PROPOSAL_SCHEME,
    path: proposal.path,
    query: proposal.id,
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    proposedUri,
    `${proposal.relPath} — Proposed change (CopilotX)`,
    { preview: true }
  );
}

async function acceptProposal(id) {
  const proposal = proposals.get(id);
  if (!proposal) {
    vscode.window.showWarningMessage('CopilotX: proposal no longer available.');
    return null;
  }
  const dirtyDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && d.uri.fsPath === proposal.path && d.isDirty
  );
  if (dirtyDoc) {
    vscode.window.showErrorMessage(
      `CopilotX: ${proposal.relPath} has unsaved edits in an open editor. ` +
        'Save or revert that buffer first so the applied change is not lost, then accept again.'
    );
    return null;
  }
  try {
    const result = applyProposal(proposal);
    proposals.delete(id);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(proposal.path));
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
    vscode.window.showInformationMessage(
      `CopilotX applied: ${proposal.relPath} (+${proposal.diff.added}/-${proposal.diff.removed})`
    );
    return result;
  } catch (err) {
    vscode.window.showErrorMessage(`CopilotX could not apply the change: ${err.message}`);
    return null;
  }
}

function discardProposal(id) {
  proposals.delete(id);
  vscode.window.setStatusBarMessage('CopilotX: change discarded.', 3000);
}

module.exports = {
  registerProposalReview,
  storeProposal,
  getProposal,
  listPendingProposals,
  reviewProposal,
  acceptProposal,
  discardProposal,
};
