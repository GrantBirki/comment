const {inspect} = require('util')
const fs = require('fs')
const path = require('path')
const core = require('@actions/core')
const github = require('@actions/github')
const nunjucks = require('nunjucks')
const yaml = require('js-yaml')

const REACTION_TYPES = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
]

class SafeTemplateLoader extends nunjucks.Loader {
  constructor(searchPath) {
    super()
    this.searchPath = path.resolve(searchPath)
    this.realSearchPath = fs.existsSync(this.searchPath)
      ? fs.realpathSync(this.searchPath)
      : null
    this.noCache = true
  }

  getSource(name) {
    if (!this.realSearchPath) {
      return null
    }

    const fullPath = path.resolve(this.searchPath, name)
    const relativePath = path.relative(this.searchPath, fullPath)

    if (
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath) ||
      !fs.existsSync(fullPath)
    ) {
      return null
    }

    const realFullPath = fs.realpathSync(fullPath)
    const realRelativePath = path.relative(this.realSearchPath, realFullPath)
    const stats = fs.statSync(realFullPath)

    if (
      realRelativePath.startsWith('..') ||
      path.isAbsolute(realRelativePath) ||
      !stats.isFile()
    ) {
      return null
    }

    return {
      src: fs.readFileSync(realFullPath, 'utf8'),
      path: realFullPath,
      noCache: this.noCache
    }
  }
}

function getInputs(actionsCore = core) {
  const reactions =
    actionsCore.getInput('reactions') || actionsCore.getInput('reaction-type')

  return {
    token: actionsCore.getInput('token'),
    repository: actionsCore.getInput('repository'),
    issueNumber: actionsCore.getInput('issue-number'),
    commentId: actionsCore.getInput('comment-id'),
    body: actionsCore.getInput('body'),
    editMode: actionsCore.getInput('edit-mode'),
    vars: actionsCore.getInput('vars'),
    file: actionsCore.getInput('file'),
    reactions
  }
}

function sanitizeInputs(inputs) {
  return {
    ...inputs,
    token: inputs.token ? '[secure]' : ''
  }
}

function resolveIssueNumber(issueNumber, githubContext) {
  if (issueNumber) {
    return issueNumber
  }

  const payload = githubContext && githubContext.payload
  if (!payload) {
    return ''
  }

  if (payload.issue && payload.issue.number) {
    return payload.issue.number
  }

  if (payload.pull_request && payload.pull_request.number) {
    return payload.pull_request.number
  }

  return payload.number || ''
}

function resolveRepository(repositoryInput, env = process.env) {
  const repository = repositoryInput || env.GITHUB_REPOSITORY

  if (!repository) {
    throw new Error(
      "Missing repository. Provide the 'repository' input or GITHUB_REPOSITORY."
    )
  }

  const parts = repository.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repository '${repository}'. Expected 'owner/repo'.`
    )
  }

  return {
    repository,
    owner: parts[0],
    repo: parts[1]
  }
}

function parseVars(vars) {
  if (!vars) {
    return {}
  }

  const parsed = yaml.load(vars, {
    schema: yaml.JSON_SCHEMA,
    json: true
  })

  if (parsed === undefined || parsed === null) {
    return {}
  }

  if (
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed instanceof Date
  ) {
    throw new Error("The 'vars' input must be a YAML mapping")
  }

  return parsed
}

async function renderComment(file, vars) {
  const yamlVars = parseVars(vars)
  const resolvedFile = path.resolve(file)
  const templateDirectory = path.dirname(resolvedFile)
  const templateName = path.basename(resolvedFile)
  const environment = new nunjucks.Environment(
    new SafeTemplateLoader(templateDirectory),
    {autoescape: true}
  )
  return environment.render(templateName, yamlVars)
}

function validReactions(reactions, actionsCore = core) {
  return [
    ...new Set(
      reactions
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .filter(item => {
          if (!REACTION_TYPES.includes(item)) {
            actionsCore.info(`Skipping invalid reaction '${item}'.`)
            return false
          }
          return true
        })
    )
  ]
}

async function addReactions(
  octokit,
  repo,
  commentId,
  reactions,
  actionsCore = core
) {
  const reactionSet = validReactions(reactions, actionsCore)

  if (reactionSet.length === 0) {
    actionsCore.setFailed(`No valid reactions are contained in '${reactions}'.`)
    return false
  }

  const results = await Promise.allSettled(
    reactionSet.map(async item => {
      await octokit.rest.reactions.createForIssueComment({
        owner: repo.owner,
        repo: repo.repo,
        comment_id: commentId,
        content: item
      })
      actionsCore.info(`Setting '${item}' reaction on comment.`)
    })
  )

  let hasFailure = false
  for (let i = 0, l = results.length; i < l; i++) {
    if (results[i].status === 'fulfilled') {
      actionsCore.info(
        `Added reaction '${reactionSet[i]}' to comment id '${commentId}'.`
      )
    } else if (results[i].status === 'rejected') {
      hasFailure = true
      actionsCore.error(
        `Adding reaction '${reactionSet[i]}' to comment id '${commentId}' failed with ${results[i].reason}.`
      )
    }
  }

  if (hasFailure) {
    actionsCore.setFailed('Failed to add one or more reactions.')
    return false
  }

  return true
}

async function resolveBody(inputs) {
  if (inputs.vars && !inputs.file) {
    throw new Error("The 'file' input must be provided if 'vars' is used")
  }

  if (inputs.body && inputs.file) {
    throw new Error("You can only use 'file' or 'body' inputs, not both")
  }

  if (inputs.file) {
    return renderComment(inputs.file, inputs.vars)
  }

  if (inputs.body) {
    return inputs.body
  }

  return null
}

async function updateExistingComment(octokit, repo, inputs, body, actionsCore) {
  if (!body && !inputs.reactions) {
    actionsCore.setFailed("Missing either comment 'body' or 'reactions'")
    return
  }

  if (body) {
    let commentBody = ''
    if (inputs.editMode === 'append') {
      const {data: comment} = await octokit.rest.issues.getComment({
        owner: repo.owner,
        repo: repo.repo,
        comment_id: inputs.commentId
      })
      commentBody = `${comment.body}\n`
    }

    commentBody = commentBody + body
    actionsCore.debug(`Comment body: ${commentBody}`)

    await octokit.rest.issues.updateComment({
      owner: repo.owner,
      repo: repo.repo,
      comment_id: inputs.commentId,
      body: commentBody
    })
    actionsCore.info(`Updated comment id '${inputs.commentId}'`)
    actionsCore.setOutput('comment-id', inputs.commentId)
  }

  if (inputs.reactions) {
    await addReactions(
      octokit,
      repo,
      inputs.commentId,
      inputs.reactions,
      actionsCore
    )
  }
}

async function createComment(octokit, repo, inputs, body, actionsCore) {
  if (!body) {
    actionsCore.setFailed("The 'body' or 'file' input is required")
    return
  }

  const {data: comment} = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: inputs.issueNumber,
    body
  })
  actionsCore.info(
    `Created comment id '${comment.id}' on issue '${inputs.issueNumber}'`
  )
  actionsCore.setOutput('comment-id', comment.id)

  if (inputs.reactions) {
    await addReactions(octokit, repo, comment.id, inputs.reactions, actionsCore)
  }
}

async function run({
  actionsCore = core,
  githubClient = github,
  env = process.env
} = {}) {
  try {
    const inputs = getInputs(actionsCore)
    const issueNumberFallback = resolveIssueNumber(
      inputs.issueNumber,
      githubClient.context
    )
    actionsCore.debug(`issueNumberFallback: ${issueNumberFallback}`)

    if (!inputs.issueNumber) {
      actionsCore.debug(
        `issueNumber is not set, trying to set from the issueNumberFallback: ${issueNumberFallback}`
      )
      inputs.issueNumber = issueNumberFallback
    }

    actionsCore.debug(`Inputs: ${inspect(sanitizeInputs(inputs))}`)

    const repo = resolveRepository(inputs.repository, env)
    actionsCore.debug(`repository: ${repo.repository}`)

    inputs.editMode = inputs.editMode || 'append'
    actionsCore.debug(`editMode: ${inputs.editMode}`)
    if (!['append', 'replace'].includes(inputs.editMode)) {
      actionsCore.setFailed(`Invalid edit-mode '${inputs.editMode}'`)
      return
    }

    const body = await resolveBody(inputs)
    if (!inputs.commentId && !inputs.issueNumber) {
      actionsCore.setFailed("Missing either 'issue-number' or 'comment-id'")
      return
    }

    const octokit = githubClient.getOctokit(inputs.token)

    if (inputs.commentId) {
      await updateExistingComment(octokit, repo, inputs, body, actionsCore)
    } else {
      await createComment(octokit, repo, inputs, body, actionsCore)
    }
  } catch (error) {
    actionsCore.debug(inspect(error))
    actionsCore.setFailed(error.message)
    if (error.message === 'Resource not accessible by integration') {
      actionsCore.error(`See this action's readme for details about this error`)
    }
  }
}

module.exports = {
  REACTION_TYPES,
  SafeTemplateLoader,
  addReactions,
  createComment,
  getInputs,
  parseVars,
  renderComment,
  resolveBody,
  resolveIssueNumber,
  resolveRepository,
  run,
  sanitizeInputs,
  updateExistingComment,
  validReactions
}
