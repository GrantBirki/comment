import {inspect} from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import * as core from '@actions/core'
import * as github from '@actions/github'
import nunjucks from 'nunjucks'
import yaml from 'js-yaml'

const REACTION_TYPES = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
] as const

type ReactionType = (typeof REACTION_TYPES)[number]
type AppendSeparator = 'newline' | 'none' | 'space'
type ReactionsEditMode = 'append' | 'replace'

const COMMENT_BODY_MAX_LENGTH = 65536
const TRUNCATE_WARNING = '...*[Comment body truncated]*'

interface ActionsCore {
  debug(message: string): void
  error(message: string): void
  getInput(name: string): string
  info(message: string): void
  setFailed(message: string): void
  setOutput(name: string, value: number | string): void
  warning(message: string): void
}

interface ActionInputs {
  token: string
  repository: string
  issueNumber: number | string
  commentId: string
  body: string
  editMode: string
  appendSeparator: string
  vars: string
  file: string
  reactions: string
  reactionsEditMode: string
}

interface GithubPayload {
  issue?: {
    number?: number | string
  }
  pull_request?: {
    number?: number | string
  }
  number?: number | string
}

interface GithubContext {
  payload?: GithubPayload
}

interface GithubClient {
  context: GithubContext
  getOctokit(token: string): OctokitClient
}

interface Repository {
  repository: string
  owner: string
  repo: string
}

interface CreateCommentOptions {
  owner: string
  repo: string
  issue_number: number | string
  body: string
}

interface GetCommentOptions {
  owner: string
  repo: string
  comment_id: number | string
}

interface UpdateCommentOptions {
  owner: string
  repo: string
  comment_id: number | string
  body: string
}

interface ReactionOptions {
  owner: string
  repo: string
  comment_id: number | string
  content: ReactionType
}

interface DeleteReactionOptions {
  owner: string
  repo: string
  comment_id: number | string
  reaction_id: number
}

interface ListReactionOptions {
  owner: string
  repo: string
  comment_id: number | string
  per_page?: number
}

interface ExistingReaction {
  id: number
  content: string
  user?: null | {
    login?: string
  }
}

interface OctokitClient {
  paginate?: {
    iterator(
      endpoint: (options: ListReactionOptions) => Promise<{
        data: ExistingReaction[]
      }>,
      options: ListReactionOptions
    ): AsyncIterable<{data: ExistingReaction[]}>
  }
  rest: {
    issues: {
      createComment(
        options: CreateCommentOptions
      ): Promise<{data: {id: number | string}}>
      getComment(options: GetCommentOptions): Promise<{
        data: {
          body?: null | string
        }
      }>
      updateComment(
        options: UpdateCommentOptions
      ): Promise<{data: {id: number | string}}>
    }
    reactions: {
      createForIssueComment(options: ReactionOptions): Promise<unknown>
      deleteForIssueComment(options: DeleteReactionOptions): Promise<unknown>
      listForIssueComment(options: ListReactionOptions): Promise<{
        data: ExistingReaction[]
      }>
    }
    users: {
      getAuthenticated(): Promise<{
        data: {
          login: string
        }
      }>
    }
  }
}

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>

class SafeTemplateLoader extends nunjucks.Loader {
  private readonly searchPath: string
  private readonly realSearchPath: null | string
  private readonly noCache = true

  constructor(searchPath: string) {
    super()
    this.searchPath = path.resolve(searchPath)
    this.realSearchPath = fs.existsSync(this.searchPath)
      ? fs.realpathSync(this.searchPath)
      : null
  }

  getSource(name: string): null | nunjucks.LoaderSource {
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

function getInputs(actionsCore: ActionsCore = core): ActionInputs {
  const reactions =
    actionsCore.getInput('reactions') || actionsCore.getInput('reaction-type')

  return {
    token: actionsCore.getInput('token'),
    repository: actionsCore.getInput('repository'),
    issueNumber: actionsCore.getInput('issue-number'),
    commentId: actionsCore.getInput('comment-id'),
    body: actionsCore.getInput('body'),
    editMode: actionsCore.getInput('edit-mode'),
    appendSeparator: actionsCore.getInput('append-separator'),
    vars: actionsCore.getInput('vars'),
    file: actionsCore.getInput('file'),
    reactions,
    reactionsEditMode: actionsCore.getInput('reactions-edit-mode')
  }
}

function sanitizeInputs(inputs: ActionInputs): ActionInputs {
  return {
    ...inputs,
    token: inputs.token ? '[secure]' : ''
  }
}

function resolveIssueNumber(
  issueNumber: number | string,
  githubContext?: GithubContext | null
): number | string {
  if (issueNumber) {
    return issueNumber
  }

  const payload = githubContext?.payload
  if (!payload) {
    return ''
  }

  if (payload.issue?.number) {
    return payload.issue.number
  }

  if (payload.pull_request?.number) {
    return payload.pull_request.number
  }

  return payload.number || ''
}

function resolveRepository(
  repositoryInput: string,
  env: Environment = process.env
): Repository {
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

function parseVars(vars: string): Record<string, unknown> {
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

  return parsed as Record<string, unknown>
}

async function renderComment(file: string, vars: string): Promise<string> {
  const yamlVars = parseVars(vars)
  const resolvedFile = path.resolve(file)
  const templateDirectory = path.dirname(resolvedFile)
  const templateName = path.basename(resolvedFile)
  const environment = new nunjucks.Environment(
    new SafeTemplateLoader(templateDirectory) as unknown as nunjucks.ILoader,
    {autoescape: true}
  )
  return environment.render(templateName, yamlVars)
}

function isReactionType(reaction: string): reaction is ReactionType {
  return (REACTION_TYPES as readonly string[]).includes(reaction)
}

function isAppendSeparator(separator: string): separator is AppendSeparator {
  return ['newline', 'none', 'space'].includes(separator)
}

function isReactionsEditMode(mode: string): mode is ReactionsEditMode {
  return ['append', 'replace'].includes(mode)
}

function validReactions(
  reactions: string,
  actionsCore: ActionsCore = core
): ReactionType[] {
  return [
    ...new Set(
      reactions
        .split(/[\n,]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .filter((item): item is ReactionType => {
          if (!isReactionType(item)) {
            actionsCore.info(`Skipping invalid reaction '${item}'.`)
            return false
          }
          return true
        })
    )
  ]
}

async function addReactionSet(
  octokit: OctokitClient,
  repo: Repository,
  commentId: number | string,
  reactionSet: ReactionType[],
  actionsCore: ActionsCore = core
): Promise<boolean> {
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
    const result = results[i]
    const reaction = reactionSet[i]
    if (!result || !reaction) {
      continue
    }

    if (result.status === 'fulfilled') {
      actionsCore.info(
        `Added reaction '${reaction}' to comment id '${commentId}'.`
      )
    } else {
      hasFailure = true
      actionsCore.error(
        `Adding reaction '${reaction}' to comment id '${commentId}' failed with ${result.reason}.`
      )
    }
  }

  if (hasFailure) {
    actionsCore.setFailed('Failed to add one or more reactions.')
    return false
  }

  return true
}

async function addReactions(
  octokit: OctokitClient,
  repo: Repository,
  commentId: number | string,
  reactions: string,
  actionsCore: ActionsCore = core
): Promise<boolean> {
  const reactionSet = validReactions(reactions, actionsCore)

  if (reactionSet.length === 0) {
    actionsCore.setFailed(`No valid reactions are contained in '${reactions}'.`)
    return false
  }

  return addReactionSet(octokit, repo, commentId, reactionSet, actionsCore)
}

async function removeReactions(
  octokit: OctokitClient,
  repo: Repository,
  commentId: number | string,
  reactions: ExistingReaction[],
  actionsCore: ActionsCore = core
): Promise<boolean> {
  const results = await Promise.allSettled(
    reactions.map(async reaction => {
      await octokit.rest.reactions.deleteForIssueComment({
        owner: repo.owner,
        repo: repo.repo,
        comment_id: commentId,
        reaction_id: reaction.id
      })
      actionsCore.info(`Removing '${reaction.content}' reaction from comment.`)
    })
  )

  let hasFailure = false
  for (let i = 0, l = results.length; i < l; i++) {
    const result = results[i]
    const reaction = reactions[i]
    if (!result || !reaction) {
      continue
    }

    if (result.status === 'fulfilled') {
      actionsCore.info(
        `Removed reaction '${reaction.content}' from comment id '${commentId}'.`
      )
    } else {
      hasFailure = true
      actionsCore.error(
        `Removing reaction '${reaction.content}' from comment id '${commentId}' failed with ${result.reason}.`
      )
    }
  }

  if (hasFailure) {
    actionsCore.setFailed('Failed to remove one or more reactions.')
    return false
  }

  return true
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function getAuthenticatedUser(octokit: OctokitClient): Promise<string> {
  try {
    const {data: user} = await octokit.rest.users.getAuthenticated()
    return user.login
  } catch (error) {
    if (
      getErrorMessage(error).includes('Resource not accessible by integration')
    ) {
      return 'github-actions[bot]'
    }
    throw error
  }
}

async function getCommentReactionsForUser(
  octokit: OctokitClient,
  repo: Repository,
  commentId: number | string,
  user: string
): Promise<ExistingReaction[]> {
  const userReactions: ExistingReaction[] = []
  const options = {
    owner: repo.owner,
    repo: repo.repo,
    comment_id: commentId,
    per_page: 100
  }

  if (octokit.paginate?.iterator) {
    for await (const {data: reactions} of octokit.paginate.iterator(
      octokit.rest.reactions.listForIssueComment,
      options
    )) {
      userReactions.push(
        ...reactions.filter(reaction => reaction.user?.login === user)
      )
    }
    return userReactions
  }

  const {data: reactions} =
    await octokit.rest.reactions.listForIssueComment(options)
  return reactions.filter(reaction => reaction.user?.login === user)
}

async function replaceReactions(
  octokit: OctokitClient,
  repo: Repository,
  commentId: number | string,
  reactionSet: ReactionType[],
  actionsCore: ActionsCore = core
): Promise<boolean> {
  const authenticatedUser = await getAuthenticatedUser(octokit)
  const userReactions = await getCommentReactionsForUser(
    octokit,
    repo,
    commentId,
    authenticatedUser
  )

  if (userReactions.length > 0) {
    const removed = await removeReactions(
      octokit,
      repo,
      commentId,
      userReactions,
      actionsCore
    )
    if (!removed) {
      return false
    }
  }

  return addReactionSet(octokit, repo, commentId, reactionSet, actionsCore)
}

async function applyReactions(
  octokit: OctokitClient,
  repo: Repository,
  commentId: number | string,
  reactions: string,
  reactionsEditMode: string,
  actionsCore: ActionsCore = core
): Promise<boolean> {
  const reactionSet = validReactions(reactions, actionsCore)

  if (reactionSet.length === 0) {
    actionsCore.setFailed(`No valid reactions are contained in '${reactions}'.`)
    return false
  }

  if (reactionsEditMode === 'replace') {
    return replaceReactions(octokit, repo, commentId, reactionSet, actionsCore)
  }

  return addReactionSet(octokit, repo, commentId, reactionSet, actionsCore)
}

function appendSeparatorTo(body: string, separator: string): string {
  switch (separator) {
    case 'newline':
      return `${body}\n`
    case 'space':
      return `${body} `
    default:
      return body
  }
}

function truncateBody(body: string, actionsCore: ActionsCore = core): string {
  if (body.length <= COMMENT_BODY_MAX_LENGTH) {
    return body
  }

  actionsCore.warning(
    `Comment body is too long. Truncating to ${COMMENT_BODY_MAX_LENGTH} characters.`
  )
  return (
    body.substring(0, COMMENT_BODY_MAX_LENGTH - TRUNCATE_WARNING.length) +
    TRUNCATE_WARNING
  )
}

async function resolveBody(inputs: ActionInputs): Promise<null | string> {
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

async function updateExistingComment(
  octokit: OctokitClient,
  repo: Repository,
  inputs: ActionInputs,
  body: null | string,
  actionsCore: ActionsCore
): Promise<void> {
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
      commentBody = appendSeparatorTo(
        comment.body || '',
        inputs.appendSeparator
      )
    }

    commentBody = truncateBody(commentBody + body, actionsCore)
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
    await applyReactions(
      octokit,
      repo,
      inputs.commentId,
      inputs.reactions,
      inputs.reactionsEditMode,
      actionsCore
    )
  }
}

async function createComment(
  octokit: OctokitClient,
  repo: Repository,
  inputs: ActionInputs,
  body: null | string,
  actionsCore: ActionsCore
): Promise<void> {
  if (!body) {
    actionsCore.setFailed("The 'body' or 'file' input is required")
    return
  }

  const {data: comment} = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: inputs.issueNumber,
    body: truncateBody(body, actionsCore)
  })
  actionsCore.info(
    `Created comment id '${comment.id}' on issue '${inputs.issueNumber}'`
  )
  actionsCore.setOutput('comment-id', comment.id)

  if (inputs.reactions) {
    await applyReactions(
      octokit,
      repo,
      comment.id,
      inputs.reactions,
      inputs.reactionsEditMode,
      actionsCore
    )
  }
}

interface RunOptions {
  actionsCore?: ActionsCore
  githubClient?: GithubClient
  env?: Environment
}

async function run({
  actionsCore = core,
  githubClient = github as unknown as GithubClient,
  env = process.env
}: RunOptions = {}): Promise<void> {
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

    inputs.appendSeparator = inputs.appendSeparator || 'newline'
    actionsCore.debug(`appendSeparator: ${inputs.appendSeparator}`)
    if (!isAppendSeparator(inputs.appendSeparator)) {
      actionsCore.setFailed(
        `Invalid append-separator '${inputs.appendSeparator}'`
      )
      return
    }

    inputs.reactionsEditMode = inputs.reactionsEditMode || 'append'
    actionsCore.debug(`reactionsEditMode: ${inputs.reactionsEditMode}`)
    if (!isReactionsEditMode(inputs.reactionsEditMode)) {
      actionsCore.setFailed(
        `Invalid reactions-edit-mode '${inputs.reactionsEditMode}'`
      )
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
    const message = getErrorMessage(error)
    actionsCore.debug(inspect(error))
    actionsCore.setFailed(message)
    if (message === 'Resource not accessible by integration') {
      actionsCore.error(`See this action's readme for details about this error`)
    }
  }
}

export {
  REACTION_TYPES,
  SafeTemplateLoader,
  addReactions,
  appendSeparatorTo,
  applyReactions,
  createComment,
  getInputs,
  getAuthenticatedUser,
  getCommentReactionsForUser,
  parseVars,
  renderComment,
  replaceReactions,
  resolveBody,
  resolveIssueNumber,
  resolveRepository,
  run,
  sanitizeInputs,
  truncateBody,
  updateExistingComment,
  validReactions
}

export type {
  ActionInputs,
  ActionsCore,
  AppendSeparator,
  CreateCommentOptions,
  DeleteReactionOptions,
  ExistingReaction,
  GetCommentOptions,
  GithubClient,
  GithubContext,
  ListReactionOptions,
  OctokitClient,
  ReactionOptions,
  ReactionType,
  ReactionsEditMode,
  Repository,
  UpdateCommentOptions
}
