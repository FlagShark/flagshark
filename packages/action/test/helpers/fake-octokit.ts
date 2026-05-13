/**
 * Hand-rolled fake of the @actions/github surface used by run(). Implements
 * just the issues.listComments / createComment / updateComment subset.
 */

export interface FakeComment { id: number; body: string }

export interface FakeOctokitState {
  comments: FakeComment[]
  calls: { list: number; create: number; update: number }
  nextId: number
}

export function makeFakeOctokit(initial: FakeComment[] = []): {
  state: FakeOctokitState
  octokit: {
    rest: {
      issues: {
        listComments: (args: { owner: string; repo: string; issue_number: number; per_page?: number }) => Promise<{ data: FakeComment[] }>
        createComment: (args: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{ data: FakeComment }>
        updateComment: (args: { owner: string; repo: string; comment_id: number; body: string }) => Promise<{ data: FakeComment }>
      }
    }
  }
} {
  const state: FakeOctokitState = {
    comments: [...initial],
    calls: { list: 0, create: 0, update: 0 },
    nextId: initial.length + 1,
  }

  return {
    state,
    octokit: {
      rest: {
        issues: {
          async listComments() {
            state.calls.list++
            return { data: [...state.comments] }
          },
          async createComment(args) {
            state.calls.create++
            const c: FakeComment = { id: state.nextId++, body: args.body }
            state.comments.push(c)
            return { data: c }
          },
          async updateComment(args) {
            state.calls.update++
            const c = state.comments.find((x) => x.id === args.comment_id)
            if (c) c.body = args.body
            return { data: c! }
          },
        },
      },
    },
  }
}

export interface FakeContext {
  repo: { owner: string; repo: string }
  payload: {
    pull_request?: {
      number: number
      base: { ref: string }
      head: { sha: string }
    }
  }
}

export function makeFakeGithub(opts: {
  pullRequest?: { number: number; baseRef: string; headSha: string }
  octokit: ReturnType<typeof makeFakeOctokit>['octokit']
}): {
  context: FakeContext
  getOctokit: (token: string) => typeof opts.octokit
} {
  const context: FakeContext = {
    repo: { owner: 'flagshark', repo: 'flagshark' },
    payload: opts.pullRequest
      ? {
          pull_request: {
            number: opts.pullRequest.number,
            base: { ref: opts.pullRequest.baseRef },
            head: { sha: opts.pullRequest.headSha },
          },
        }
      : {},
  }
  return { context, getOctokit: () => opts.octokit }
}
