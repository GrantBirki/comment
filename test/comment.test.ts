import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LocalActionsCore,
  addReactions,
  appendSeparatorTo,
  createGithubClient,
  getAuthenticatedUser,
  getInputs,
  getCommentReactionsForUser,
  parseVars,
  renderComment,
  resolveIssueNumber,
  resolveRepository,
  run,
  sanitizeInputs,
  truncateBody,
  validReactions
} from '../src/comment.js'
import type {
  ActionsCore,
  CreateCommentOptions,
  DeleteReactionOptions,
  ExistingReaction,
  GetCommentOptions,
  GithubClient,
  GithubContext,
  OctokitClient,
  ReactionOptions,
  Repository,
  UpdateCommentOptions
} from '../src/comment.js'

interface CoreCalls {
  debug: string[]
  error: string[]
  failed: string[]
  info: string[]
  outputs: Record<string, number | string>
  warning: string[]
}

interface TestCore extends ActionsCore {
  calls: CoreCalls
}

function makeCore(inputs: Record<string, string> = {}): TestCore {
  const calls: CoreCalls = {
    debug: [],
    error: [],
    failed: [],
    info: [],
    outputs: {},
    warning: []
  }

  return {
    calls,
    debug(message: string) {
      calls.debug.push(String(message))
    },
    error(message: string) {
      calls.error.push(String(message))
    },
    getInput(name: string) {
      return inputs[name] || ''
    },
    info(message: string) {
      calls.info.push(String(message))
    },
    setFailed(message: string) {
      calls.failed.push(String(message))
    },
    setOutput(name: string, value: number | string) {
      calls.outputs[name] = value
    },
    warning(message: string) {
      calls.warning.push(String(message))
    }
  }
}

interface OctokitCalls {
  createComment: CreateCommentOptions[]
  deleteReaction: DeleteReactionOptions[]
  getComment: GetCommentOptions[]
  getAuthenticated: number
  listReactions: number
  reactions: ReactionOptions[]
  updateComment: UpdateCommentOptions[]
}

interface TestOctokit extends OctokitClient {
  calls: OctokitCalls
}

interface MakeOctokitOptions {
  createId?: number
  existingBody?: string
  failReaction?: string
  getAuthenticatedFails?: boolean
  reactions?: ExistingReaction[]
}

function makeOctokit({
  createId = 101,
  existingBody = 'existing comment',
  failReaction,
  getAuthenticatedFails = false,
  reactions = []
}: MakeOctokitOptions = {}): TestOctokit {
  const calls: OctokitCalls = {
    createComment: [],
    deleteReaction: [],
    getComment: [],
    getAuthenticated: 0,
    listReactions: 0,
    reactions: [],
    updateComment: []
  }

  return {
    calls,
    rest: {
      issues: {
        async createComment(options: CreateCommentOptions) {
          calls.createComment.push(options)
          return {data: {id: createId}}
        },
        async getComment(options: GetCommentOptions) {
          calls.getComment.push(options)
          return {data: {body: existingBody}}
        },
        async updateComment(options: UpdateCommentOptions) {
          calls.updateComment.push(options)
          return {data: {id: options.comment_id}}
        }
      },
      reactions: {
        async createForIssueComment(options: ReactionOptions) {
          calls.reactions.push(options)
          if (options.content === failReaction) {
            throw new Error(`failed ${options.content}`)
          }
          return {data: {content: options.content}}
        },
        async deleteForIssueComment(options: DeleteReactionOptions) {
          calls.deleteReaction.push(options)
          return {data: {}}
        },
        async listForIssueComment() {
          calls.listReactions += 1
          return {data: reactions}
        }
      },
      users: {
        async getAuthenticated() {
          calls.getAuthenticated += 1
          if (getAuthenticatedFails) {
            throw new Error('Resource not accessible by integration')
          }
          return {data: {login: 'github-actions[bot]'}}
        }
      }
    }
  }
}

interface TestGithubClient extends GithubClient {
  calls: {
    getOctokit: string[]
  }
}

function makeGithubClient(
  octokit: OctokitClient,
  context: GithubContext = {payload: {}}
): TestGithubClient {
  const calls = {
    getOctokit: [] as string[]
  }

  return {
    calls,
    context,
    getOctokit(token: string) {
      calls.getOctokit.push(token)
      return octokit
    }
  }
}

function writeTemplate(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-action-'))
  const file = path.join(directory, 'template.md')
  fs.writeFileSync(file, contents)
  return file
}

function writeTemplates(files: Record<string, string>): {
  directory: string
  file: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-action-'))
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), contents)
  }
  return {
    directory,
    file: path.join(directory, 'template.md')
  }
}

function captureStdout(fn: () => void): string {
  const originalWrite = process.stdout.write
  let output = ''

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    fn()
  } finally {
    process.stdout.write = originalWrite
  }

  return output
}

test('getInputs prefers reactions over deprecated reaction-type', () => {
  assert.deepEqual(
    getInputs(
      makeCore({
        body: 'hello',
        reactions: 'eyes',
        'reaction-type': 'rocket',
        repository: 'owner/repo',
        token: 'token'
      })
    ),
    {
      token: 'token',
      repository: 'owner/repo',
      issueNumber: '',
      commentId: '',
      body: 'hello',
      editMode: '',
      appendSeparator: '',
      vars: '',
      file: '',
      reactions: 'eyes',
      reactionsEditMode: ''
    }
  )

  assert.equal(
    getInputs(makeCore({'reaction-type': 'rocket'})).reactions,
    'rocket'
  )
})

test('LocalActionsCore reads inputs and emits escaped workflow commands', () => {
  const core = new LocalActionsCore({
    'INPUT_BODY': '  hello  ',
    'INPUT_REACTION-TYPE': ' rocket '
  })

  assert.equal(core.getInput('body'), 'hello')
  assert.equal(core.getInput('reaction-type'), 'rocket')

  const output = captureStdout(() => {
    core.debug('line 1\nline 2')
    core.warning('100%, ok')
    core.setOutput('comment-id', '123')
  })

  assert.match(output, /::debug::line 1%0Aline 2/)
  assert.match(output, /::warning::100%25, ok/)
  assert.match(output, /::set-output name=comment-id::123/)
})

test('LocalActionsCore writes multiline outputs to GITHUB_OUTPUT', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-output-'))
  const outputFile = path.join(directory, 'github-output')
  const core = new LocalActionsCore({GITHUB_OUTPUT: outputFile})

  core.setOutput('comment-id', 'line 1\nline 2')

  const output = fs.readFileSync(outputFile, 'utf8')
  assert.match(output, /^comment-id<<comment_/)
  assert.match(output, /line 1\nline 2/)
})

test('createGithubClient maps issue comment REST requests', async () => {
  const originalFetch = globalThis.fetch
  const calls: {init?: RequestInit; url: string}[] = []

  globalThis.fetch = (async (input, init) => {
    calls.push({url: String(input), init})
    return new Response(JSON.stringify({id: 123}), {status: 201})
  }) as typeof fetch

  try {
    const octokit = createGithubClient({
      GITHUB_API_URL: 'https://github.example/api/v3'
    }).getOctokit('secret-token')
    const response = await octokit.rest.issues.createComment({
      owner: 'owner',
      repo: 'repo',
      issue_number: 7,
      body: 'hello'
    })

    assert.equal(response.data.id, 123)
    assert.equal(
      calls[0]?.url,
      'https://github.example/api/v3/repos/owner/repo/issues/7/comments'
    )
    assert.equal(calls[0]?.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      body: 'hello'
    })
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
      'Bearer secret-token'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createGithubClient preserves GitHub error messages for auth fallback', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({message: 'Resource not accessible by integration'}),
      {status: 403}
    )
  }) as typeof fetch

  try {
    const octokit = createGithubClient().getOctokit('token')
    assert.equal(await getAuthenticatedUser(octokit), 'github-actions[bot]')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createGithubClient paginates comment reactions from Link headers', async () => {
  const originalFetch = globalThis.fetch
  const requestedPages: string[] = []

  globalThis.fetch = (async input => {
    const url = new URL(String(input))
    const page = url.searchParams.get('page') || '1'
    requestedPages.push(page)

    if (page === '1') {
      return new Response(
        JSON.stringify([
          {id: 1, content: 'eyes', user: {login: 'github-actions[bot]'}},
          {id: 2, content: 'rocket', user: {login: 'octocat'}}
        ]),
        {
          status: 200,
          headers: {
            link: '<https://api.github.com/reactions?page=2>; rel="next"'
          }
        }
      )
    }

    return new Response(
      JSON.stringify([
        {id: 3, content: 'heart', user: {login: 'github-actions[bot]'}}
      ]),
      {status: 200}
    )
  }) as typeof fetch

  try {
    const octokit = createGithubClient().getOctokit('token')
    const reactions = await getCommentReactionsForUser(
      octokit,
      {owner: 'owner', repo: 'repo', repository: 'owner/repo'},
      99,
      'github-actions[bot]'
    )

    assert.deepEqual(
      reactions.map(reaction => reaction.id),
      [1, 3]
    )
    assert.deepEqual(requestedPages, ['1', '2'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('parseVars accepts only YAML mappings', () => {
  assert.deepEqual(parseVars('app: cool-app\nenvironment: production'), {
    app: 'cool-app',
    environment: 'production'
  })
  assert.deepEqual(parseVars('count: 3\nenabled: true\nitems:\n  - a\n  - b'), {
    count: 3,
    enabled: true,
    items: ['a', 'b']
  })
  assert.deepEqual(parseVars(''), {})
  assert.deepEqual(parseVars('---\n'), {})
  assert.deepEqual(parseVars('items: [a, b]\nempty: null'), {
    items: ['a', 'b'],
    empty: null
  })
  assert.throws(() => parseVars('- app'), /YAML mapping/)
  assert.throws(() => parseVars('hello'), /YAML mapping/)
  assert.throws(
    () => parseVars('a: 1\n---\nb: 2'),
    /expected a single document/
  )
  assert.throws(() => parseVars('base: &base\n  app: cool-app'), /anchors/)
  assert.throws(() => parseVars('copy: *base'), /aliases/)
  assert.throws(() => parseVars('<<: *base'), /merge keys|aliases/)
  assert.throws(() => parseVars('app: !secret value'), /custom YAML tags/)
  assert.throws(
    () => parseVars('items:\n  - !secret value'),
    /custom YAML tags/
  )
})

test('renderComment renders a template with escaped variables', async () => {
  const file = writeTemplate('Hello {{ name }} {{ unsafe }}')

  assert.equal(
    await renderComment(file, 'name: Ada\nunsafe: "<script>"'),
    'Hello Ada &lt;script&gt;'
  )
})

test('renderComment supports same-directory includes without broad filesystem access', async () => {
  const {file} = writeTemplates({
    'template.md': 'Hello {% include "partial.md" %}',
    'partial.md': '{{ name }}'
  })

  assert.equal(await renderComment(file, 'name: Ada'), 'Hello Ada')
})

test('renderComment rejects includes outside the template directory', async () => {
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
  const outsideFile = path.join(outsideDirectory, 'secret.md')
  fs.writeFileSync(outsideFile, 'should not render')
  const {file} = writeTemplates({
    'template.md': `Hello {% include "${outsideFile}" %}`
  })

  await assert.rejects(() => renderComment(file, ''), /template not found/)
})

test('renderComment rejects traversal to sibling paths with shared prefixes', async () => {
  const parentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'comment-safe-')
  )
  const templateDirectory = path.join(parentDirectory, 'templates')
  const siblingDirectory = path.join(parentDirectory, 'templates-secret')
  fs.mkdirSync(templateDirectory)
  fs.mkdirSync(siblingDirectory)
  fs.writeFileSync(
    path.join(siblingDirectory, 'secret.md'),
    'should not render'
  )
  const file = path.join(templateDirectory, 'template.md')
  fs.writeFileSync(file, 'Hello {% include "../templates-secret/secret.md" %}')

  await assert.rejects(() => renderComment(file, ''), /template not found/)
})

test('renderComment rejects symlinks outside the template directory', async () => {
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
  const outsideFile = path.join(outsideDirectory, 'secret.md')
  fs.writeFileSync(outsideFile, 'should not render')
  const {directory, file} = writeTemplates({
    'template.md': 'Hello {% include "linked-secret.md" %}'
  })
  fs.symlinkSync(outsideFile, path.join(directory, 'linked-secret.md'))

  await assert.rejects(() => renderComment(file, ''), /template not found/)
})

test('renderComment rejects templates from missing directories', async () => {
  const file = path.join(
    os.tmpdir(),
    `comment-missing-${process.pid}`,
    'template.md'
  )

  await assert.rejects(() => renderComment(file, ''), /template not found/)
})

test('resolveIssueNumber supports explicit input and event fallbacks', () => {
  assert.equal(resolveIssueNumber('7', {payload: {number: 9}}), '7')
  assert.equal(resolveIssueNumber('', {payload: {issue: {number: 11}}}), 11)
  assert.equal(
    resolveIssueNumber('', {payload: {pull_request: {number: 12}}}),
    12
  )
  assert.equal(resolveIssueNumber('', {payload: {number: 13}}), 13)
  assert.equal(resolveIssueNumber('', null), '')
  assert.equal(resolveIssueNumber('', {payload: {}}), '')
})

test('resolveRepository requires an owner/repo repository name', () => {
  assert.deepEqual(resolveRepository('owner/repo', {}), {
    owner: 'owner',
    repo: 'repo',
    repository: 'owner/repo'
  })
  assert.deepEqual(resolveRepository('', {GITHUB_REPOSITORY: 'env/repo'}), {
    owner: 'env',
    repo: 'repo',
    repository: 'env/repo'
  })
  assert.throws(() => resolveRepository('', {}), /Missing repository/)
  assert.throws(() => resolveRepository('owner', {}), /Expected 'owner\/repo'/)
  assert.throws(
    () => resolveRepository('owner/repo/extra', {}),
    /Expected 'owner\/repo'/
  )
})

test('sanitizeInputs masks the token before debug logging', () => {
  assert.deepEqual(
    sanitizeInputs({...getInputs(makeCore()), token: 'secret'}),
    {
      token: '[secure]',
      repository: '',
      issueNumber: '',
      commentId: '',
      body: '',
      editMode: '',
      appendSeparator: '',
      vars: '',
      file: '',
      reactions: '',
      reactionsEditMode: ''
    }
  )
  assert.deepEqual(sanitizeInputs({...getInputs(makeCore()), body: 'hello'}), {
    token: '',
    repository: '',
    issueNumber: '',
    commentId: '',
    body: 'hello',
    editMode: '',
    appendSeparator: '',
    vars: '',
    file: '',
    reactions: '',
    reactionsEditMode: ''
  })
})

test('validReactions trims, filters, and de-duplicates reaction inputs', () => {
  const core = makeCore()

  assert.deepEqual(validReactions(' eyes, rocket\neyes\nheart, nope ', core), [
    'eyes',
    'rocket',
    'heart'
  ])
  assert.match(core.calls.info.join('\n'), /Skipping invalid reaction 'nope'/)
})

test('appendSeparatorTo supports newline, space, and none separators', () => {
  assert.equal(appendSeparatorTo('old', 'newline'), 'old\n')
  assert.equal(appendSeparatorTo('old', 'space'), 'old ')
  assert.equal(appendSeparatorTo('old', 'none'), 'old')
})

test('truncateBody keeps short bodies and truncates long bodies with a warning', () => {
  const core = makeCore()
  const shortBody = 'hello'
  const longBody = 'a'.repeat(66000)
  const truncateWarning = '...*[Comment body truncated]*'

  assert.equal(truncateBody(shortBody, core), shortBody)

  const truncated = truncateBody(longBody, core)
  assert.equal(truncated.length, 65536)
  assert.equal(truncated.endsWith(truncateWarning), true)
  assert.deepEqual(core.calls.warning, [
    'Comment body is too long. Truncating to 65536 characters.'
  ])
})

test('addReactions adds valid reactions and skips invalid entries', async () => {
  const core = makeCore()
  const octokit = makeOctokit()

  assert.equal(
    await addReactions(
      octokit,
      {owner: 'owner', repo: 'repo', repository: 'owner/repo'},
      123,
      'eyes, rocket, nope, eyes',
      core
    ),
    true
  )
  assert.deepEqual(
    octokit.calls.reactions.map(call => call.content),
    ['eyes', 'rocket']
  )
  assert.equal(core.calls.failed.length, 0)
})

test('addReactions fails when no valid reactions are provided', async () => {
  const core = makeCore()
  const octokit = makeOctokit()
  const repo: Repository = {
    owner: 'owner',
    repo: 'repo',
    repository: 'owner/repo'
  }

  assert.equal(await addReactions(octokit, repo, 123, 'nope', core), false)
  assert.equal(octokit.calls.reactions.length, 0)
  assert.deepEqual(core.calls.failed, [
    "No valid reactions are contained in 'nope'."
  ])
})

test('addReactions fails when GitHub rejects a reaction', async () => {
  const core = makeCore()
  const octokit = makeOctokit({failReaction: 'rocket'})
  const repo: Repository = {
    owner: 'owner',
    repo: 'repo',
    repository: 'owner/repo'
  }

  assert.equal(
    await addReactions(octokit, repo, 123, 'eyes,rocket', core),
    false
  )
  assert.equal(octokit.calls.reactions.length, 2)
  assert.match(core.calls.error.join('\n'), /failed rocket/)
  assert.deepEqual(core.calls.failed, ['Failed to add one or more reactions.'])
})

test('run creates a rendered comment with pull request fallback metadata', async () => {
  const file = writeTemplate('Deploy {{ app }} to {{ environment }}')
  const core = makeCore({
    file,
    token: 'secret-token',
    vars: 'app: cool-app\nenvironment: production'
  })
  const octokit = makeOctokit({createId: 456})
  const githubClient = makeGithubClient(octokit, {
    payload: {pull_request: {number: 33}}
  })

  await run({
    actionsCore: core,
    githubClient,
    env: {GITHUB_REPOSITORY: 'owner/repo'}
  })

  assert.deepEqual(octokit.calls.createComment, [
    {
      owner: 'owner',
      repo: 'repo',
      issue_number: 33,
      body: 'Deploy cool-app to production'
    }
  ])
  assert.deepEqual(core.calls.outputs, {'comment-id': 456})
  assert.equal(githubClient.calls.getOctokit[0], 'secret-token')
  assert.doesNotMatch(core.calls.debug.join('\n'), /secret-token/)
  assert.match(core.calls.debug.join('\n'), /\[secure\]/)
})

test('run updates an existing comment in append mode by default', async () => {
  const core = makeCore({
    body: 'new content',
    'comment-id': '99',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit({existingBody: 'old content'})
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(octokit.calls.getComment, [
    {owner: 'owner', repo: 'repo', comment_id: '99'}
  ])
  assert.deepEqual(octokit.calls.updateComment, [
    {
      owner: 'owner',
      repo: 'repo',
      comment_id: '99',
      body: 'old content\nnew content'
    }
  ])
  assert.deepEqual(core.calls.outputs, {'comment-id': '99'})
})

test('run supports space and none append separators', async () => {
  const spaceCore = makeCore({
    body: 'new content',
    'comment-id': '99',
    'append-separator': 'space',
    repository: 'owner/repo',
    token: 'token'
  })
  const spaceOctokit = makeOctokit({existingBody: 'old content'})

  await run({
    actionsCore: spaceCore,
    githubClient: makeGithubClient(spaceOctokit)
  })

  assert.deepEqual(spaceOctokit.calls.updateComment, [
    {
      owner: 'owner',
      repo: 'repo',
      comment_id: '99',
      body: 'old content new content'
    }
  ])

  const noneCore = makeCore({
    body: 'new content',
    'comment-id': '99',
    'append-separator': 'none',
    repository: 'owner/repo',
    token: 'token'
  })
  const noneOctokit = makeOctokit({existingBody: 'old content'})

  await run({
    actionsCore: noneCore,
    githubClient: makeGithubClient(noneOctokit)
  })

  assert.deepEqual(noneOctokit.calls.updateComment, [
    {
      owner: 'owner',
      repo: 'repo',
      comment_id: '99',
      body: 'old contentnew content'
    }
  ])
})

test('run replaces an existing comment without fetching the old body', async () => {
  const core = makeCore({
    body: 'replacement content',
    'comment-id': '99',
    'edit-mode': 'replace',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.equal(octokit.calls.getComment.length, 0)
  assert.deepEqual(octokit.calls.updateComment, [
    {
      owner: 'owner',
      repo: 'repo',
      comment_id: '99',
      body: 'replacement content'
    }
  ])
})

test('run supports reaction-only updates to an existing comment', async () => {
  const core = makeCore({
    'comment-id': '99',
    reactions: 'heart,hooray',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.equal(octokit.calls.getComment.length, 0)
  assert.equal(octokit.calls.updateComment.length, 0)
  assert.deepEqual(
    octokit.calls.reactions.map(call => call.content),
    ['heart', 'hooray']
  )
})

test('run replaces reactions for the authenticated user', async () => {
  const core = makeCore({
    'comment-id': '99',
    reactions: 'heart\nhooray',
    'reactions-edit-mode': 'replace',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit({
    reactions: [
      {id: 1, content: 'eyes', user: {login: 'github-actions[bot]'}},
      {id: 2, content: 'rocket', user: {login: 'github-actions[bot]'}},
      {id: 3, content: 'laugh', user: {login: 'octocat'}}
    ]
  })

  await run({actionsCore: core, githubClient: makeGithubClient(octokit)})

  assert.equal(octokit.calls.getAuthenticated, 1)
  assert.equal(octokit.calls.listReactions, 1)
  assert.deepEqual(
    octokit.calls.deleteReaction.map(call => call.reaction_id),
    [1, 2]
  )
  assert.deepEqual(
    octokit.calls.reactions.map(call => call.content),
    ['heart', 'hooray']
  )
  assert.equal(core.calls.failed.length, 0)
})

test('run falls back to github-actions bot when replacing reactions with GITHUB_TOKEN restrictions', async () => {
  const core = makeCore({
    'comment-id': '99',
    reactions: 'heart',
    'reactions-edit-mode': 'replace',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit({
    getAuthenticatedFails: true,
    reactions: [{id: 1, content: 'eyes', user: {login: 'github-actions[bot]'}}]
  })

  await run({actionsCore: core, githubClient: makeGithubClient(octokit)})

  assert.deepEqual(
    octokit.calls.deleteReaction.map(call => call.reaction_id),
    [1]
  )
  assert.deepEqual(
    octokit.calls.reactions.map(call => call.content),
    ['heart']
  )
})

test('run adds reactions when creating a new comment', async () => {
  const core = makeCore({
    body: 'hello',
    'issue-number': '1',
    reactions: 'eyes',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit({createId: 456})
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(octokit.calls.createComment, [
    {owner: 'owner', repo: 'repo', issue_number: '1', body: 'hello'}
  ])
  assert.deepEqual(octokit.calls.reactions, [
    {owner: 'owner', repo: 'repo', comment_id: 456, content: 'eyes'}
  ])
})

test('run truncates long bodies before creating and updating comments', async () => {
  const longBody = 'a'.repeat(66000)
  const truncateWarning = '...*[Comment body truncated]*'
  const createCore = makeCore({
    body: longBody,
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const createOctokit = makeOctokit()

  await run({
    actionsCore: createCore,
    githubClient: makeGithubClient(createOctokit)
  })

  const createdBody = createOctokit.calls.createComment[0]?.body || ''
  assert.equal(createdBody.length, 65536)
  assert.equal(createdBody.endsWith(truncateWarning), true)
  assert.equal(createCore.calls.warning.length, 1)

  const updateCore = makeCore({
    body: longBody,
    'comment-id': '99',
    repository: 'owner/repo',
    token: 'token'
  })
  const updateOctokit = makeOctokit({existingBody: 'old content'})

  await run({
    actionsCore: updateCore,
    githubClient: makeGithubClient(updateOctokit)
  })

  const updatedBody = updateOctokit.calls.updateComment[0]?.body || ''
  assert.equal(updatedBody.length, 65536)
  assert.equal(updatedBody.endsWith(truncateWarning), true)
  assert.equal(updateCore.calls.warning.length, 1)
})

test('run supports deprecated reaction-type when reactions is not set', async () => {
  const core = makeCore({
    body: 'hello',
    'issue-number': '1',
    'reaction-type': 'rocket',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit({createId: 456})
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(octokit.calls.reactions, [
    {owner: 'owner', repo: 'repo', comment_id: 456, content: 'rocket'}
  ])
})

test('run rejects empty updates to an existing comment', async () => {
  const core = makeCore({
    'comment-id': '99',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "Missing either comment 'body' or 'reactions'"
  ])
  assert.equal(octokit.calls.updateComment.length, 0)
})

test('run rejects new comments without a body or file', async () => {
  const core = makeCore({
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "The 'body' or 'file' input is required"
  ])
  assert.equal(octokit.calls.createComment.length, 0)
})

test('run rejects invalid edit modes before calling GitHub', async () => {
  const core = makeCore({
    body: 'hello',
    'edit-mode': 'overwrite',
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, ["Invalid edit-mode 'overwrite'"])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects invalid append separators before calling GitHub', async () => {
  const core = makeCore({
    body: 'hello',
    'append-separator': 'tab',
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, ["Invalid append-separator 'tab'"])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects invalid reactions edit modes before calling GitHub', async () => {
  const core = makeCore({
    body: 'hello',
    'reactions-edit-mode': 'overwrite',
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "Invalid reactions-edit-mode 'overwrite'"
  ])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects vars without a file before calling GitHub', async () => {
  const core = makeCore({
    body: 'hello',
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token',
    vars: 'app: cool-app'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "The 'file' input must be provided if 'vars' is used"
  ])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects body and file together before calling GitHub', async () => {
  const file = writeTemplate('hello')
  const core = makeCore({
    body: 'hello',
    file,
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "You can only use 'file' or 'body' inputs, not both"
  ])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects missing issue and comment identifiers before calling GitHub', async () => {
  const core = makeCore({
    body: 'hello',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "Missing either 'issue-number' or 'comment-id'"
  ])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects invalid repository names before calling GitHub', async () => {
  const core = makeCore({
    body: 'hello',
    'issue-number': '1',
    repository: 'owner/repo/extra',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    "Invalid repository 'owner/repo/extra'. Expected 'owner/repo'."
  ])
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run rejects template rendering failures before calling GitHub', async () => {
  const core = makeCore({
    file: path.join(os.tmpdir(), 'missing-template.md'),
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const octokit = makeOctokit()
  const githubClient = makeGithubClient(octokit)

  await run({actionsCore: core, githubClient})

  assert.match(core.calls.failed.join('\n'), /template not found/)
  assert.equal(githubClient.calls.getOctokit.length, 0)
})

test('run includes the readme hint for integration permission errors', async () => {
  const core = makeCore({
    body: 'hello',
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const githubClient: GithubClient = {
    context: {payload: {}},
    getOctokit() {
      throw new Error('Resource not accessible by integration')
    }
  }

  await run({actionsCore: core, githubClient})

  assert.deepEqual(core.calls.failed, [
    'Resource not accessible by integration'
  ])
  assert.match(core.calls.error.join('\n'), /readme/)
})
