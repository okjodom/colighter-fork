import {
  RouterliciousDocumentServiceFactory,
  createNostrCreateNewRequest,
  MockCollabRelay,
  NostrCollabLoader,
  NostrRelayTokenProvider,
  NostrRelayUrlResolver,
  StaticCodeLoader,
} from "nostrcollab";
import { Relay, getNostrUser } from "nostrfn";
import { DEFAULT_HIGHLIGHT_COLOR } from "./constants";
import { HighlightContainerRuntimeFactory } from "./container";
import { Highlight } from "./model";
import {
  ActionResponse,
  ColorDescription,
  IHighlight,
  IHighlightCollection,
  IHighlightCollectionAppModel,
  MessageAction,
  StorageKey,
} from "./types";
import {
  tryReadLocalStorage,
  sha256Hash,
  tryWriteLocalStorage,
  serializeRange,
  writeLocalStorage,
} from "./utils";

let color: ColorDescription = DEFAULT_HIGHLIGHT_COLOR;
const HIGHLIGHT_KEY: string = "NPKryv4iXxihMRg2gxRkTfFhwXmNmX9F";
let collab: IHighlightCollection | null = null;

/**
 * Listen for highlight mesages and take actions that render highlights on the page
 */
chrome.runtime.onMessage.addListener((request: any, _sender, sendResponse) => {
  (async () => {
    let outcome: ActionResponse;

    switch (request.action) {
      case MessageAction.LOAD_COLLAB:
        if (collab) {
          outcome = {
            success: true,
            data: "Collab already loaded",
          } as ActionResponse;
          break;
        }

        outcome = await loadCollab(request.data).catch((e) => {
          return (outcome = {
            success: false,
            error: e,
          } as ActionResponse);
        });
        break;

      case MessageAction.GET_COLLAB_HIGHLIGHTS:
        if (collab !== null) {
          outcome = await collab
            .getHighlights()
            .then((highlights) => {
              return (outcome = {
                success: true,
                data: highlights,
              } as ActionResponse);
            })
            .catch((e) => {
              return (outcome = {
                success: false,
                error: e,
              } as ActionResponse);
            });
          break;
        }

        outcome = {
          success: false,
          error: "Collab not ready",
        } as ActionResponse;
        break;

      case MessageAction.TOGGLE_HIGHLIGHTS:
        if (request.data) {
          // TODO: render all highlights
        } else {
          // TODO: remove all highlights
        }
        outcome = { success: true };
        break;
      case MessageAction.SELECT_COLOR:
        color = request.data;
        outcome = { success: true };
        break;
      case MessageAction.RENDER_HIGHLIGHTS:
        if (request.data) {
          // We don't know how to render collab highlights yet
          // TODO: Render submitted highlights
          outcome = {
            success: false,
            error: "Not implemented",
          } as ActionResponse;
          break;
        }

        outcome = await highlightText().catch((e) => {
          return (outcome = {
            success: false,
            error: e,
          } as ActionResponse);
        });
        break;
      case MessageAction.REMOVE_HIGHLIGHTS:
        outcome = removeHighlight();
        break;
      default:
        outcome = {
          success: false,
          error: "Unknown message action",
        } as ActionResponse;
        break;
    }

    sendResponse(outcome);
  })();
});

const getSelectionInfo = (): {
  selection: Selection | null;
  range: Range | null;
  text: string;
} => {
  const selection = window.getSelection();
  let range: Range | null = null;
  let text = "";

  if (selection) {
    range = selection.getRangeAt(0);
    text = range.toString();
  }
  return { selection, range, text };
};

/* Highlight given selection */
const highlightText = async (): Promise<ActionResponse> => {
  const { selection, range, text } = getSelectionInfo();

  if (selection === null || range === null) {
    return {
      success: false,
      error: "Failed to get selection",
    } as ActionResponse;
  }

  if (!text) {
    return { success: false, error: "No text selected" } as ActionResponse;
  }

  let parent = getHighlightedMark(selection);

  if (parent?.className !== HIGHLIGHT_KEY) {
    let mark: HTMLElement = document.createElement("mark");
    mark.setAttribute("style", `background-color: #${color.val}`);
    mark.className = HIGHLIGHT_KEY;
    let sel: Selection | null = window.getSelection();

    if (sel?.rangeCount) {
      let range: Range = sel.getRangeAt(0).cloneRange();
      range.surroundContents(mark);
      sel.removeAllRanges();
      sel.addRange(range);

      return await trySaveHighlight(range, text);
    }
  }

  return { success: false, error: "Already highlighted" } as ActionResponse;
};

/* Remove highlight for given selected text */
const removeHighlight = (): ActionResponse => {
  const { selection, range, text } = getSelectionInfo();

  if (selection === null || range === null) {
    return {
      success: false,
      error: "Failed to get selection",
    } as ActionResponse;
  }

  if (!text) {
    return { success: false, error: "No text selected" } as ActionResponse;
  }

  let mark = getHighlightedMark(selection);

  if (mark?.className === HIGHLIGHT_KEY) {
    let parent: Node | null = mark.parentNode;
    let text: Text | null = document.createTextNode(mark.innerHTML);

    parent?.insertBefore(text, mark);
    mark.remove();

    return { success: true };
  }

  return {
    success: false,
    error: "Failed to remove highlight",
  } as ActionResponse;
};

/* Get parent element from selected text */
const getHighlightedMark = (selection: Selection): HTMLElement | null => {
  let parent: HTMLElement | null = null;
  parent = selection.getRangeAt(0).commonAncestorContainer as HTMLElement;
  if (parent.nodeType !== 1) {
    parent = parent.parentNode as HTMLElement;
  }
  return parent;
};

const trySaveHighlight = async (
  range: Range,
  text: string
): Promise<ActionResponse> => {
  if (collab === null) {
    return {
      success: false,
      error: "Collab model not ready",
    } as ActionResponse;
  }

  try {
    const rangeSer = serializeRange(range);
    const highlight = await Highlight.create(text, rangeSer, "0x000000");
    await collab.addHighlight(highlight);
    return { success: true };
  } catch (e) {
    return { success: false, error: e } as ActionResponse;
  }
};

const loadCollab = async (url: string): Promise<ActionResponse> => {
  const collabRelayUrl =
    process.env.COLLAB_RELAY_URL ?? "http://localhost:7070";
  const collabRelay = new MockCollabRelay(
    "wss://mockcollabrelay",
    1,
    collabRelayUrl
  ) as unknown as Relay;

  const tokenProvider = new NostrRelayTokenProvider(
    collabRelay,
    await getNostrUser()
  );

  // Create a new Fluid loader, load the highlight collection
  const loader = new NostrCollabLoader<IHighlightCollectionAppModel>({
    urlResolver: new NostrRelayUrlResolver(collabRelay),
    documentServiceFactory: new RouterliciousDocumentServiceFactory(
      tokenProvider
    ),
    codeLoader: new StaticCodeLoader(new HighlightContainerRuntimeFactory()),
    generateCreateNewRequest: createNostrCreateNewRequest,
  });

  let storageKey = await sha256Hash(url);
  let collabId = await tryReadLocalStorage<string>(storageKey);

  if (!collabId) {
    const createResponse = await loader.createDetached("0.1.0");
    collab = createResponse.collab.highlightCollection;
    tryWriteLocalStorage<string>(storageKey, await createResponse.attach());
  } else {
    collab = (await loader.loadExisting(collabId)).highlightCollection;
  }

  // Listen for changes to the highlight collection
  const changeListener = async () => {
    const highlights = await collab!.getHighlights();

    // Request render highlights on canvas
    chrome.runtime
      .sendMessage({
        action: MessageAction.RENDER_HIGHLIGHTS,
        data: highlights,
      })
      .catch((e) => {
        console.error(e);
      });

    // Request render of highlights on popup UI
    chrome.runtime
      .sendMessage({
        action: MessageAction.POST_COLLAB_HIGHLIGHTS,
        data: highlights,
      })
      .catch((e) => {
        console.error(e);
      });

    // Write highlights to local storage for when the popup is closed
    await writeLocalStorage<IHighlight[]>(
      StorageKey.COLLAB_HIGHLIGHTS,
      highlights
    ).catch((e) => {
      console.error(e);
    });
  };

  collab?.on("highlightCollectionChanged", changeListener);

  return { success: true };
};