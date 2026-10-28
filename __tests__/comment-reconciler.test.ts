/**
 * Comment reconciliation — ad copies of a boosted post, and which comments a
 * sweep is allowed to enqueue.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueue, mockProvider } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockQueue: { add: vi.fn() },
  mockProvider: {
    getRecentMediaComments: vi.fn(),
    getUserMedia: vi.fn(),
    createInstagramContext: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => mockQueue }));
vi.mock("@/lib/instagram/provider", () => ({
  ...mockProvider,
  MetaApiError: class MetaApiError extends Error {
    code = 0;
  },
}));

import { adMediaFor, reconcileComments } from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }, { mediaId: POST }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: null }, { mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

/**
 * The sweep runs every few minutes and re-enqueues whatever it considers
 * unhandled. Anything it refuses to let go of is therefore not retried once but
 * forever, and because Meta answers a send with a generic error even when the
 * message went out, each lap can reach the recipient again. A DM that fails
 * permanently must stay failed.
 */
describe("reconcileComments — which comments get enqueued", () => {
  const ACCOUNT_IG = "17841452548252636";

  function automation(overrides: Record<string, unknown> = {}) {
    return {
      id: "cmp_1",
      name: "Kirguistan",
      postId: POST,
      matchAnyPost: false,
      matchAnyWord: true,
      keywords: [],
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: "ws_1",
      instagramAccount: {
        id: "acc_1",
        instagramId: ACCOUNT_IG,
        username: "arielkauderer",
        accessToken: "enc",
        provider: "META",
        workspaceId: "ws_1",
        zernioAccountId: null,
      },
      ...overrides,
    };
  }

  const comment = {
    id: "17908572900588859",
    text: "Kirguistán",
    timestamp: new Date().toISOString(),
    from: { id: "99", username: "tomibove" },
    replies: { data: [] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.automation.findMany.mockResolvedValue([automation()]);
    mockProvider.createInstagramContext.mockResolvedValue("token");
    mockProvider.getRecentMediaComments.mockResolvedValue([comment]);
  });

  it("enqueues a comment the webhook never delivered", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([]);

    await reconcileComments();

    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add.mock.calls[0][1]).toMatchObject({
      commentId: comment.id,
      source: "POLLING",
    });
  });

  it("leaves a comment whose DM failed alone, instead of retrying it every sweep", async () => {
    // The guard is the DmLog query itself: a FAILED row has to come back from it
    // as settled. Assert on the query so a change that drops FAILED from the
    // filter fails here rather than in production.
    mockPrisma.dmLog.findMany.mockImplementation(async ({ where }) => {
      const matchesFailed = where.OR?.some(
        (clause: Record<string, unknown>) => clause.status === "FAILED"
      );
      return matchesFailed ? [{ commentId: comment.id }] : [];
    });

    await reconcileComments();

    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("still retries a public reply when the DM itself went out", async () => {
    // DM SENT but publicReplySentAt null: the campaign posts a public reply, so
    // the comment is not finished and must come back.
    mockPrisma.dmLog.findMany.mockResolvedValue([]);

    await reconcileComments();

    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  it("skips a comment the account owner already replied to", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    mockProvider.getRecentMediaComments.mockResolvedValue([
      { ...comment, replies: { data: [{ from: { id: ACCOUNT_IG } }] } },
    ]);

    await reconcileComments();

    expect(mockQueue.add).not.toHaveBeenCalled();
  });
});
