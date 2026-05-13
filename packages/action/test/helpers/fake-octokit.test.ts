import { describe, it, expect } from 'vitest'
import { makeFakeOctokit, makeFakeGithub } from './fake-octokit.js'

describe('fake-octokit', () => {
  it('list/create/update flow', async () => {
    const fk = makeFakeOctokit()
    expect((await fk.octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1 })).data).toEqual([])
    await fk.octokit.rest.issues.createComment({ owner: 'o', repo: 'r', issue_number: 1, body: 'hi' })
    const list = await fk.octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1 })
    expect(list.data[0].body).toBe('hi')

    await fk.octokit.rest.issues.updateComment({ owner: 'o', repo: 'r', comment_id: list.data[0].id, body: 'updated' })
    const list2 = await fk.octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1 })
    expect(list2.data[0].body).toBe('updated')
    expect(fk.state.calls).toEqual({ list: 3, create: 1, update: 1 })
  })

  it('makeFakeGithub with pull request', () => {
    const fk = makeFakeOctokit()
    const gh = makeFakeGithub({
      pullRequest: { number: 42, baseRef: 'main', headSha: 'abc' },
      octokit: fk.octokit,
    })
    expect(gh.context.payload.pull_request?.number).toBe(42)
    expect(gh.context.payload.pull_request?.base.ref).toBe('main')
  })

  it('makeFakeGithub without pull request has empty payload', () => {
    const fk = makeFakeOctokit()
    const gh = makeFakeGithub({ octokit: fk.octokit })
    expect(gh.context.payload.pull_request).toBeUndefined()
  })
})
