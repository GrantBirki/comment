const {inspect} = require('util')
const core = require('@actions/core')
const github = require('@actions/github')
const nunjucks = require('nunjucks')
const yaml = require('js-yaml')

// Valid reaction types
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

// Helper function for adding reactions to a comment
async function addReactions(octokit, repo, comment_id, reactions) {
  let ReactionsSet = [
    ...new Set(
      reactions
        .replace(/\s/g, '')
        .split(',')
        .filter(item => {
          if (!REACTION_TYPES.includes(item)) {
            core.info(`Skipping invalid reaction '${item}'.`)
            return false
          }
          return true
        })
    )
  ]

  // If an invalid reaction is used, fail the workflow
  if (!ReactionsSet) {
    core.setFailed(`No valid reactions are contained in '${reactions}'.`)
    return false
  }

  let results = await Promise.allSettled(
    ReactionsSet.map(async item => {
      await octokit.rest.reactions.createForIssueComment({
        owner: repo[0],
        repo: repo[1],
        comment_id: comment_id,
        content: item
      })
      core.info(`Setting '${item}' reaction on comment.`)
    })
  )

  for (let i = 0, l = results.length; i < l; i++) {
    if (results[i].status === 'fulfilled') {
      core.info(
        `Added reaction '${ReactionsSet[i]}' to comment id '${comment_id}'.`
      )
    } else if (results[i].status === 'rejected') {
      core.info(
        `Adding reaction '${ReactionsSet[i]}' to comment id '${comment_id}' failed with ${results[i].reason}.`
      )
    }
  }
  ReactionsSet = undefined
  results = undefined
}

// Helper function for rendering a comment body from a file with optional variables
async function renderComment(file, vars) {
  // Parse the variables from the input if they exist
  var yamlVars = {}
  if (vars) {
    yamlVars = yaml.loadAll(vars)[0]
  }

  // Render the comment as a string from the file
  nunjucks.configure({autoescape: true})
  return nunjucks.render(file, yamlVars)
}

// The main function that runs the workflow
async function run() {
  try {
    // Collect all the Action inputs
    const inputs = {
      token: core.getInput('token'),
      repository: core.getInput('repository'),
      issueNumber: core.getInput('issue-number'),
      commentId: core.getInput('comment-id'),
      body: core.getInput('body'),
      editMode: core.getInput('edit-mode'),
      vars: core.getInput('vars'),
      file: core.getInput('file'),
      reactions: core.getInput('reactions')
        ? core.getInput('reactions')
        : core.getInput('reaction-type')
    }

    core.debug(`issueNumber: ${inputs.issueNumber}`)

    // in most cases, ${{ github.event.number }} is the issue number
    // if it is blank, then try to fetch it from the context
    const issueNumberFallback =
      github &&
      github.context &&
      github.context.payload &&
      github.context.payload.issue &&
      github.context.payload.issue.number
    core.debug(`issueNumberFallback: ${issueNumberFallback}`)
    if (!inputs.issueNumber) {
      core.debug(
        `issueNumber is not set, trying to set from the issueNumberFallback: ${issueNumberFallback}`
      )
      inputs.issueNumber = issueNumberFallback
    }

    core.debug(`Inputs: ${inspect(inputs)}`)

    // Get the GitHub repository
    const repository = inputs.repository
      ? inputs.repository
      : process.env.GITHUB_REPOSITORY
    const repo = repository.split('/')
    core.debug(`repository: ${repository}`)

    // Determine the edit mode (append or replace)
    const editMode = inputs.editMode ? inputs.editMode : 'append'
    core.debug(`editMode: ${editMode}`)
    if (!['append', 'replace'].includes(editMode)) {
      core.setFailed(`Invalid edit-mode '${editMode}'`)
      return
    }

    // If the vars input is provided without a file, fail the workflow
    if (inputs.vars && !inputs.file) {
      core.setFailed(`The 'file' input must be provided if 'vars' is used`)
      return
    }

    // If a body is provided, and a file is provided, fail the workflow
    if (inputs.body && inputs.file) {
      core.setFailed(`You can only use 'file' or 'body' inputs, not both`)
      return
    }

    // If a file is provided, render the comment body from the file and try to use any vars if they exist
    let body = ''
    if (inputs.file) {
      body = await renderComment(inputs.file, inputs.vars)
    } else if (inputs.body) {
      body = inputs.body
    } else {
      body = null
    }

    // Create an Octokit instance
    const octokit = github.getOctokit(inputs.token)

    // Logic for editing existing comments
    if (inputs.commentId) {
      if (!body && !inputs.reactions) {
        core.setFailed("Missing either comment 'body' or 'reactions'")
        return
      }

      if (body) {
        var commentBody = ''
        if (editMode == 'append') {
          // Get the comment body
          const {data: comment} = await octokit.rest.issues.getComment({
            owner: repo[0],
            repo: repo[1],
            comment_id: inputs.commentId
          })
          commentBody = comment.body + '\n'
        }

        // Append the current comment body with the input body provided
        commentBody = commentBody + body
        core.debug(`Comment body: ${commentBody}`)

        // Update the comment with the appended comment body
        await octokit.rest.issues.updateComment({
          owner: repo[0],
          repo: repo[1],
          comment_id: inputs.commentId,
          body: commentBody
        })
        core.info(`Updated comment id '${inputs.commentId}'`)
        core.setOutput('comment-id', inputs.commentId)
      }

      // Set comment reactions
      if (inputs.reactions) {
        await addReactions(octokit, repo, inputs.commentId, inputs.reactions)
      }

      // Logic for creating brand new comments
    } else if (inputs.issueNumber) {
      if (!body) {
        core.setFailed("The 'body' or 'file' input is required")
        return
      }

      // Create the comment
      const {data: comment} = await octokit.rest.issues.createComment({
        owner: repo[0],
        repo: repo[1],
        issue_number: inputs.issueNumber,
        body: body
      })
      core.info(
        `Created comment id '${comment.id}' on issue '${inputs.issueNumber}'`
      )
      core.setOutput('comment-id', comment.id)

      // Set comment reactions
      if (inputs.reactions) {
        await addReactions(octokit, repo, comment.id, inputs.reactions)
      }
    } else {
      core.setFailed("Missing either 'issue-number' or 'comment-id'")
      return
    }
  } catch (error) {
    core.debug(inspect(error))
    core.setFailed(error.message)
    if (error.message == 'Resource not accessible by integration') {
      core.error(`See this action's readme for details about this error`)
    }
  }
}

run()
