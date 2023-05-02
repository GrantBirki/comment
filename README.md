# Comment Action 💬

[![Check dist/](https://github.com/GrantBirki/comment/actions/workflows/check-dist.yml/badge.svg)](https://github.com/GrantBirki/comment/actions/workflows/check-dist.yml)

GitHub Action to create, update, or add a reaction to any issue or pull request

## Features 🌟

- Create a comment
- Update a comment
- Add a reaction to a comment
- Create or update a comment from a markdown file
- Create or update a comment from a markdown file with template variable rendering

## Usage 💻

The section below will contain a few common examples for how you can use this Action

### Create a Comment ✏️

```yml
    - name: Create comment
      uses: GrantBirki/comment@vX.X.X
      with:
        body: |
          This is a multi-line test comment

          - With GitHub **Markdown** ✨
          - Cool!
        reactions: '+1'
```

> This will create a brand new comment on an issue/pr with the comment body seen above. It will also add a 👍 reaction

### Update a Comment 📝

```yml
    - name: Update comment
      uses: GrantBirki/comment@vX.X.X
      with:
        comment-id: 123456789
        body: |
          **Edit:** Some additional info
        reactions: eyes
```

> This will update the comment with the comment body seen above in the default `append` mode. It will also add a 👀 reaction

### Add Comment Reactions 👍

```yml
    - name: Add reactions
      uses: GrantBirki/comment@vX.X.X
      with:
        comment-id: 123456789
        reactions: heart, hooray, laugh
```

> This will add three reactions to the comment specified by the comment-id

### Use a File as the Comment Body 📂

```yml
    - name: Create comment from markdown file
      uses: GrantBirki/comment@vX.X.X
      with:
        file: demo/plain-sample.md
```

> This will create a comment and use the markdown file contents as the comment body

### Use a File as the Comment Body with Template Variables 📜

```yml
    - name: Create comment from markdown file with variables
      uses: GrantBirki/comment@vX.X.X
      with:
        file: demo/render-sample.md
        vars: |
          sha: ${{ github.sha }}
          environment: production
          app: cool-app
```

> This will create a comment and use the markdown file contents as the comment body with the variables specified in the vars section for template rendering

For more information about **templating**, be sure to check out the [templating](#templating) section below

### Inputs 📥

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `token` | `GITHUB_TOKEN` (`issues: write`, `pull-requests: write`) or a `repo` scoped [PAT](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token) | true | `${{ github.token }}` |
| `repository` | The full name of the repository in which to create or update a comment | true | `${{ github.repository }}` |
| `issue-number` | The number of the issue or pull request in which to create a comment | true | `${{ github.event.number }}` |
| `comment-id` | The id of the comment to update | false |  |
| `body` | The comment body (string) | false | |
| `file` | The path to a file to use as a comment body | false | |
| `vars` | Template variables in yaml format for rendering with a provided file | false | |
| `edit-mode` | The mode when updating a comment, `replace` or `append` | false | `append` |
| `reactions` | A comma separated list of reactions to add to the comment (`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`) | false | |

#### Outputs 📤

| Name | Description |
| --- | --- |
| `comment-id` | The ID of the created comment |

The ID of the created comment will be output for use in later steps
Note that in order to read the step output the action step must have an id.

```yml
    - name: Create comment
      uses: GrantBirki/comment@vX.X.X
      id: comment
      with:
        body: hello world

    - name: Check outputs
      run: echo "Comment ID - ${{ steps.comment.outputs.comment-id }}"
```

### Issue Number 🔢

> Common error: `Missing either 'issue-number' or 'comment-id'`

The `issue-number` field can be omitted depending on the type of workflow you are using and it will attempt to find the PR/issue number from the event context automatically

The fallback value is as follows: `${{ github.event.number }}`

You can always pass in an exact value for the `issue-number` field if you wish to override the automatic lookup. The example below obtains the issue number from the event context in a specific way:

```yaml
  with:
    issue-number: ${{ github.event.issue.number }}
```

> Note: Pull Requests are just Issues under the hood, so when we refer to the `issue-number` that could also be exchanged for a PR number

### Templating

There are two ways to leverage templates using this Action:

- Simple Template - Just pass in a `file: <path>` to the Action
- Template Rendering - Pass in a `file: <path>` and `vars: <values>` to the Action

> ⚠️ Important: Make sure to run the [action/checkout](https://github.com/actions/checkout) Action *before* this Action if using the `file:` input so the action can actually read files from your repo

`file` and `vars` explained:

- `file` is the path to a markdown file in your repository to load as a template
- `vars` are template variables to use when rendering your markdown file template

The `vars` input is a yaml string that will be parsed and converted to a map of key/value pairs. An example can be seen below

Actions workflow:

```yml
  with:
    file: demo/render-sample.md
    vars: |
      sha: ${{ github.sha }}
      environment: production
      app: cool-app
```

Markdown Template:

```markdown
# Deployment Status 🚀

**{{ app }}** has been successfully deployed to **{{ environment }}**

- SHA: `{{ sha }}`
```

This Action uses [nunjucks](https://github.com/mozilla/nunjucks) to render template files with the `vars` variables provided. You can fully leverage all the features nunjucks has to offer to custimize templates to your heart's content.

An example of a markdown template file can be seen [here](demo/render-sample.md). When this Action runs, it will render the `demo/render-sample.md` file with the `vars` provided to dynamically generate the comment body!

You can even pass in GitHub Actions context variables as seen above (ex: `${{ github.sha }}`)

> Checkout a sample workflow file [here](demo/sample-workflow.yml) to see this in action

#### Iterating Over Arrays in Templates

This example shows how you can iterate over an array of values and populate a template with them:

```yaml
jobs:
  example:
    runs-on: ubuntu-latest
    steps:
      - id: run
        run:  echo "files=a,b,c" >> "$GITHUB_OUTPUT"

      - uses: GrantBirki/comment@vX.X.X
        with:
          # other config
          vars: |
            files: ${{ steps.run.outputs.files }}
          body: |
            # Files
            {% for file in files.split(",") %}
            - `{{ file }}`
            {% else %}
            - No file
            {% endfor %}
```

> Source: [#11](https://github.com/GrantBirki/comment/issues/11)

### Where to Find the ID of a Comment 🔍

> How to find the id of a comment will depend a lot on the use case

Here is one example where the id can be found in the `github` context during an `issue_comment` event:

```yml
on:
  issue_comment:
    types: [created]
jobs:
  commentCreated:
    runs-on: ubuntu-latest
    steps:
      - name: Add reaction
        uses: GrantBirki/comment@vX.X.X
        with:
          comment-id: ${{ github.event.comment.id }}
          reactions: eyes
```

> You can also use the [find-comment](https://github.com/peter-evans/find-comment) Action to locate the comment id in many different ways

### Error: Repository Not Found 🚫

If you are trying to use this Action with its template features, you will need to checkout the repository first before calling this Action. This ensure the proper files are available to be read by the Action. If your `actions/checkout` job fails with `Repository Not Found`, it is likely due to missing permissions. Try adding this at the top of your Actions workflow file:

```yml
permissions:
  issues: write # needed for creating comments on issues
  pull-requests: write # needed for creating comments on pull requests
  contents: read # bingo!
```

Assigning `read` to the `contents` permission will allow Actions to checkout your repository

### Error: Resource not Accessible by Integration ❌

Common causes can be seen below

#### Workflow triggered from a fork

In *public* repositories this action does not work in `pull_request` workflows when triggered by forks

Any attempt will be met with the error, `Resource not accessible by integration`

#### Insufficient Permissions

This Action needs `write` access to issue, pull requests, or both depending on how you are using it:

```yml
permissions:
  issues: write
  pull-requests: write
```

### Accessing Issues and Comments in other Repositories 🧑‍🤝‍🧑

You can create and update comments in another repository by using a [PAT](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token) instead of `GITHUB_TOKEN`.

The user associated with the PAT must have write access to the repository

### Inspiration 🌠

This Action was largely inspired by the [create-or-update-comment](https://github.com/peter-evans/create-or-update-comment) Action by [@peter-evans](https://github.com/peter-evans). In fact, it shared the majority of the code with that Action. The reason this Action was created was because a comment Action was needed that supported template rendering and was not available in the `create-or-update-comment`. It was suggested to use a second Action [render-template](https://github.com/chuhlomin/render-template) and pass the outputs of that Action into the `create-or-update-comment` Action.

This Action solves that problem by using the [nunjucks](https://github.com/mozilla/nunjucks) package for full template rendering

## License

[MIT](LICENSE)
