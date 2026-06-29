import {randomUUID} from 'node:crypto'
import {EOL} from 'node:os'
import {inspect} from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import nunjucks from 'nunjucks'

import {ACTION_VERSION} from './version.js'

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
  page?: number
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
        headers?: Headers
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
        headers?: Headers
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

function escapeCommandData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeCommandProperty(value: string): string {
  return escapeCommandData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function issueCommand(
  command: string,
  message: string,
  properties: Record<string, string> = {}
): void {
  const propertyEntries = Object.entries(properties)
  const propertyText =
    propertyEntries.length === 0
      ? ''
      : ` ${propertyEntries
          .map(([key, value]) => `${key}=${escapeCommandProperty(value)}`)
          .join(',')}`

  process.stdout.write(`::${command}${propertyText}::${escapeCommandData(message)}${EOL}`)
}

function inputEnvironmentName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
}

class LocalActionsCore implements ActionsCore {
  constructor(private readonly env: Environment = process.env) {}

  debug(message: string): void {
    issueCommand('debug', String(message))
  }

  error(message: string): void {
    issueCommand('error', String(message))
  }

  getInput(name: string): string {
    return (this.env[inputEnvironmentName(name)] || '').trim()
  }

  info(message: string): void {
    process.stdout.write(`${message}${EOL}`)
  }

  setFailed(message: string): void {
    process.exitCode = 1
    this.error(message)
  }

  setOutput(name: string, value: number | string): void {
    const output = String(value)
    const outputPath = this.env.GITHUB_OUTPUT

    if (outputPath) {
      let delimiter = `comment_${randomUUID()}`
      while (output.includes(delimiter)) {
        delimiter = `comment_${randomUUID()}`
      }

      fs.appendFileSync(
        outputPath,
        `${name}<<${delimiter}${EOL}${output}${EOL}${delimiter}${EOL}`
      )
      return
    }

    issueCommand('set-output', output, {name})
  }

  warning(message: string): void {
    issueCommand('warning', String(message))
  }
}

function readGithubPayload(env: Environment): GithubPayload {
  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {}
  }

  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8')) as GithubPayload
  } catch {
    return {}
  }
}

function createGithubClient(env: Environment = process.env): GithubClient {
  return {
    context: {
      payload: readGithubPayload(env)
    },
    getOctokit(token: string): OctokitClient {
      return new LocalOctokit(token, env)
    }
  }
}

interface GithubRequestOptions {
  method: string
  path: string
  query?: Record<string, number | string | undefined>
  body?: unknown
}

function encodePath(value: number | string): string {
  return encodeURIComponent(String(value))
}

function nextPageExists(linkHeader: null | string): boolean {
  return Boolean(linkHeader && /<[^>]+>;\s*rel="next"/.test(linkHeader))
}

class LocalOctokit implements OctokitClient {
  private readonly apiUrl: string

  constructor(
    private readonly token: string,
    env: Environment = process.env
  ) {
    this.apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(
      /\/+$/,
      ''
    )
  }

  paginate = {
    iterator: async function* (
      endpoint: (options: ListReactionOptions) => Promise<{
        data: ExistingReaction[]
        headers?: Headers
      }>,
      options: ListReactionOptions
    ): AsyncIterable<{data: ExistingReaction[]}> {
      let page = options.page || 1

      while (true) {
        const response = await endpoint({...options, page})
        yield {data: response.data}

        if (!nextPageExists(response.headers?.get('link') || null)) {
          return
        }

        page += 1
      }
    }
  }

  rest = {
    issues: {
      createComment: async (
        options: CreateCommentOptions
      ): Promise<{data: {id: number | string}}> => {
        return this.request({
          method: 'POST',
          path: `/repos/${encodePath(options.owner)}/${encodePath(
            options.repo
          )}/issues/${encodePath(options.issue_number)}/comments`,
          body: {body: options.body}
        })
      },
      getComment: async (options: GetCommentOptions) => {
        return this.request<{
          body?: null | string
        }>({
          method: 'GET',
          path: `/repos/${encodePath(options.owner)}/${encodePath(
            options.repo
          )}/issues/comments/${encodePath(options.comment_id)}`
        })
      },
      updateComment: async (
        options: UpdateCommentOptions
      ): Promise<{data: {id: number | string}}> => {
        return this.request({
          method: 'PATCH',
          path: `/repos/${encodePath(options.owner)}/${encodePath(
            options.repo
          )}/issues/comments/${encodePath(options.comment_id)}`,
          body: {body: options.body}
        })
      }
    },
    reactions: {
      createForIssueComment: async (
        options: ReactionOptions
      ): Promise<unknown> => {
        return this.request({
          method: 'POST',
          path: `/repos/${encodePath(options.owner)}/${encodePath(
            options.repo
          )}/issues/comments/${encodePath(options.comment_id)}/reactions`,
          body: {content: options.content}
        })
      },
      deleteForIssueComment: async (
        options: DeleteReactionOptions
      ): Promise<unknown> => {
        return this.request({
          method: 'DELETE',
          path: `/repos/${encodePath(options.owner)}/${encodePath(
            options.repo
          )}/issues/comments/${encodePath(
            options.comment_id
          )}/reactions/${encodePath(options.reaction_id)}`
        })
      },
      listForIssueComment: async (options: ListReactionOptions) => {
        return this.request<ExistingReaction[]>({
          method: 'GET',
          path: `/repos/${encodePath(options.owner)}/${encodePath(
            options.repo
          )}/issues/comments/${encodePath(options.comment_id)}/reactions`,
          query: {
            per_page: options.per_page,
            page: options.page
          }
        })
      }
    },
    users: {
      getAuthenticated: async (): Promise<{
        data: {
          login: string
        }
      }> => {
        return this.request({
          method: 'GET',
          path: '/user'
        })
      }
    }
  }

  private async request<T>({
    method,
    path: requestPath,
    query = {},
    body
  }: GithubRequestOptions): Promise<{data: T; headers: Headers}> {
    const url = new URL(`${this.apiUrl}${requestPath}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'user-agent': 'GrantBirki/comment',
      'x-github-api-version': '2022-11-28'
    }

    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const responseText = await response.text()
    const data = responseText ? JSON.parse(responseText) : undefined

    if (!response.ok) {
      const message =
        data && typeof data === 'object' && 'message' in data
          ? String(data.message)
          : `${response.status} ${response.statusText}`
      throw new Error(message)
    }

    return {data: data as T, headers: response.headers}
  }
}

const defaultActionsCore = new LocalActionsCore()

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

function getInputs(actionsCore: ActionsCore = defaultActionsCore): ActionInputs {
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

interface VarsLine {
  indent: number
  text: string
}

function stripComment(line: string): string {
  let quote: null | string = null

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const previous = line[i - 1]

    if ((char === '"' || char === "'") && previous !== '\\') {
      quote = quote === char ? null : quote || char
      continue
    }

    if (!quote && char === '#' && (!previous || /\s/.test(previous))) {
      return line.slice(0, i)
    }
  }

  return line
}

function assertSupportedVarsSyntax(text: string): void {
  if (/^!/.test(text) || /^-\s*!/.test(text) || /:\s*!/.test(text)) {
    throw new Error("The 'vars' input does not support custom YAML tags")
  }

  if (/^\s*<<\s*:/.test(text) || /:\s*<<\s*:/.test(text)) {
    throw new Error("The 'vars' input does not support YAML merge keys")
  }

  if (/(^|\s)&[A-Za-z0-9_-]+/.test(text)) {
    throw new Error("The 'vars' input does not support YAML anchors")
  }

  if (/(^|\s)\*[A-Za-z0-9_-]+/.test(text)) {
    throw new Error("The 'vars' input does not support YAML aliases")
  }
}

function prepareVarsLines(vars: string): VarsLine[] {
  const rawLines = vars.replace(/\r\n?/g, '\n').split('\n')
  const lines: VarsLine[] = []
  let sawContent = false
  let sawDocumentStart = false

  for (const rawLine of rawLines) {
    if (/^\t+/.test(rawLine)) {
      throw new Error("The 'vars' input must use spaces for indentation")
    }

    const withoutComment = stripComment(rawLine).replace(/\s+$/, '')
    const text = withoutComment.trim()

    if (!text) {
      continue
    }

    if (text === '---') {
      if (sawContent || sawDocumentStart) {
        throw new Error('expected a single document in the vars input')
      }
      sawDocumentStart = true
      continue
    }

    if (text === '...') {
      throw new Error('expected a single document in the vars input')
    }

    sawContent = true
    assertSupportedVarsSyntax(text)
    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text
    })
  }

  return lines
}

function findMappingSeparator(text: string): number {
  let quote: null | string = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const previous = text[i - 1]

    if ((char === '"' || char === "'") && previous !== '\\') {
      quote = quote === char ? null : quote || char
      continue
    }

    if (!quote && char === ':') {
      return i
    }
  }

  return -1
}

function parseVarsScalar(value: string): unknown {
  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  if (value === 'null' || value === '~') {
    return null
  }

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return Number(value)
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value)
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) {
      return []
    }
    return inner.split(',').map(item => parseVarsScalar(item.trim()))
  }

  return value
}

function parseVarsBlock(
  lines: VarsLine[],
  index: number,
  indent: number
): {nextIndex: number; value: unknown} {
  if (lines[index]?.text.startsWith('- ')) {
    const values: unknown[] = []

    while (index < lines.length && lines[index]?.indent === indent) {
      const line = lines[index]
      if (!line?.text.startsWith('- ')) {
        throw new Error("The 'vars' input must be a YAML mapping")
      }

      const item = line.text.slice(2).trim()
      if (!item) {
        const nextLine = lines[index + 1]
        if (nextLine && nextLine.indent > indent) {
          const parsed = parseVarsBlock(lines, index + 1, nextLine.indent)
          values.push(parsed.value)
          index = parsed.nextIndex
          continue
        }
        values.push(null)
      } else {
        values.push(parseVarsScalar(item))
      }
      index += 1
    }

    return {nextIndex: index, value: values}
  }

  const mapping: Record<string, unknown> = {}

  while (index < lines.length && lines[index]?.indent === indent) {
    const line = lines[index]
    if (!line || line.text.startsWith('- ')) {
      throw new Error("The 'vars' input must be a YAML mapping")
    }

    const separator = findMappingSeparator(line.text)
    if (separator < 1) {
      throw new Error("The 'vars' input must be a YAML mapping")
    }

    const key = line.text.slice(0, separator).trim()
    const rawValue = line.text.slice(separator + 1).trim()

    if (!key || key === '<<') {
      throw new Error("The 'vars' input must be a YAML mapping")
    }

    if (!rawValue) {
      const nextLine = lines[index + 1]
      if (nextLine && nextLine.indent > indent) {
        const parsed = parseVarsBlock(lines, index + 1, nextLine.indent)
        mapping[key] = parsed.value
        index = parsed.nextIndex
        continue
      }
      mapping[key] = null
    } else {
      mapping[key] = parseVarsScalar(rawValue)
    }

    index += 1
  }

  return {nextIndex: index, value: mapping}
}

function parseVars(vars: string): Record<string, unknown> {
  if (!vars) {
    return {}
  }

  const lines = prepareVarsLines(vars)
  if (lines.length === 0) {
    return {}
  }

  if (lines[0]?.indent !== 0 || lines[0]?.text.startsWith('- ')) {
    throw new Error("The 'vars' input must be a YAML mapping")
  }

  const parsed = parseVarsBlock(lines, 0, 0)
  if (parsed.nextIndex !== lines.length || Array.isArray(parsed.value)) {
    throw new Error("The 'vars' input must be a YAML mapping")
  }

  return parsed.value as Record<string, unknown>
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
  actionsCore: ActionsCore = defaultActionsCore
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
  actionsCore: ActionsCore = defaultActionsCore
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
  actionsCore: ActionsCore = defaultActionsCore
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
  actionsCore: ActionsCore = defaultActionsCore
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
  actionsCore: ActionsCore = defaultActionsCore
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
  actionsCore: ActionsCore = defaultActionsCore
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

function truncateBody(
  body: string,
  actionsCore: ActionsCore = defaultActionsCore
): string {
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

async function run(options: RunOptions = {}): Promise<void> {
  const actionsCore = options.actionsCore || defaultActionsCore
  const env = options.env || process.env

  try {
    actionsCore.info(`comment-action version: ${ACTION_VERSION}`)
    const githubClient = options.githubClient || createGithubClient(env)
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
  LocalActionsCore,
  REACTION_TYPES,
  SafeTemplateLoader,
  addReactions,
  appendSeparatorTo,
  applyReactions,
  createComment,
  createGithubClient,
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
