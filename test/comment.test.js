const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  addReactions,
  parseVars,
  renderComment,
  resolveIssueNumber,
  resolveRepository,
  run,
  sanitizeInputs,
  validReactions
} = require('../src/comment')

function makeCore(inputs = {}) {
  const calls = {
    debug: [],
    error: [],
    failed: [],
    info: [],
    outputs: {}
  }

  return {
    calls,
    debug(message) {
      calls.debug.push(String(message))
    },
    error(message) {
      calls.error.push(String(message))
    },
    getInput(name) {
      return inputs[name] || ''
    },
    info(message) {
      calls.info.push(String(message))
    },
    setFailed(message) {
      calls.failed.push(String(message))
    },
    setOutput(name, value) {
      calls.outputs[name] = value
    }
  }
}

function makeOctokit({
  createId = 101,
  existingBody = 'existing comment',
  failReaction
} = {}) {
  const calls = {
    createComment: [],
    getComment: [],
    reactions: [],
    updateComment: []
  }

  return {
    calls,
    rest: {
      issues: {
        async createComment(options) {
          calls.createComment.push(options)
          return {data: {id: createId}}
        },
        async getComment(options) {
          calls.getComment.push(options)
          return {data: {body: existingBody}}
        },
        async updateComment(options) {
          calls.updateComment.push(options)
          return {data: {id: options.comment_id}}
        }
      },
      reactions: {
        async createForIssueComment(options) {
          calls.reactions.push(options)
          if (options.content === failReaction) {
            throw new Error(`failed ${options.content}`)
          }
          return {data: {content: options.content}}
        }
      }
    }
  }
}

function makeGithubClient(octokit, context = {payload: {}}) {
  const calls = {
    getOctokit: []
  }

  return {
    calls,
    context,
    getOctokit(token) {
      calls.getOctokit.push(token)
      return octokit
    }
  }
}

function writeTemplate(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-action-'))
  const file = path.join(directory, 'template.md')
  fs.writeFileSync(file, contents)
  return file
}

test('parseVars accepts only YAML mappings', () => {
  assert.deepEqual(parseVars('app: cool-app\nenvironment: production'), {
    app: 'cool-app',
    environment: 'production'
  })
  assert.deepEqual(parseVars(''), {})
  assert.deepEqual(parseVars('---\n'), {})
  assert.throws(() => parseVars('- app'), /YAML mapping/)
  assert.throws(() => parseVars('hello'), /YAML mapping/)
})

test('renderComment renders a template with escaped variables', async () => {
  const file = writeTemplate('Hello {{ name }} {{ unsafe }}')

  assert.equal(
    await renderComment(file, 'name: Ada\nunsafe: "<script>"'),
    'Hello Ada &lt;script&gt;'
  )
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
  assert.deepEqual(sanitizeInputs({token: 'secret', body: 'hello'}), {
    token: '[secure]',
    body: 'hello'
  })
})

test('validReactions trims, filters, and de-duplicates reaction inputs', () => {
  const core = makeCore()

  assert.deepEqual(validReactions(' eyes, rocket,eyes, nope ', core), [
    'eyes',
    'rocket'
  ])
  assert.match(core.calls.info.join('\n'), /Skipping invalid reaction 'nope'/)
})

test('addReactions adds valid reactions and skips invalid entries', async () => {
  const core = makeCore()
  const octokit = makeOctokit()

  assert.equal(
    await addReactions(
      octokit,
      {owner: 'owner', repo: 'repo'},
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

  assert.equal(
    await addReactions(
      octokit,
      {owner: 'owner', repo: 'repo'},
      123,
      'nope',
      core
    ),
    false
  )
  assert.equal(octokit.calls.reactions.length, 0)
  assert.deepEqual(core.calls.failed, [
    "No valid reactions are contained in 'nope'."
  ])
})

test('addReactions fails when GitHub rejects a reaction', async () => {
  const core = makeCore()
  const octokit = makeOctokit({failReaction: 'rocket'})

  assert.equal(
    await addReactions(
      octokit,
      {owner: 'owner', repo: 'repo'},
      123,
      'eyes,rocket',
      core
    ),
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

test('run includes the readme hint for integration permission errors', async () => {
  const core = makeCore({
    body: 'hello',
    'issue-number': '1',
    repository: 'owner/repo',
    token: 'token'
  })
  const githubClient = {
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
