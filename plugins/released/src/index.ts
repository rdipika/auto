import { Auto, IPlugin } from '@auto-it/core';
import { IExtendedCommit } from '@auto-it/core/dist/log-parse';
import merge from 'deepmerge';

interface IReleasedLabelPluginOptions {
  /** Message to use when posting on issues and pull requests */
  message: string;
  /** The label to add to issues and pull requests */
  label: string;
  /** Whether to lock the issue once the pull request has been released */
  lockIssues: boolean;
}

const TYPE = '%TYPE';
const VERSION = '%VERSION';
const defaultOptions = {
  label: 'released',
  lockIssues: false,
  message: `:rocket: ${TYPE} was released in ${VERSION} :rocket:`
};

const closeIssue = /(?:Close|Closes|Closed|Fix|Fixes|Fixed|Resolve|Resolves|Resolved)\s((?:#\d+(?:,\s)?)+)/gi;

/** Determine if string is a canary version */
const isCanary = (version: string) => version.match('canary');

/** Comment on merged pull requests and issues with the new version */
export default class ReleasedLabelPlugin implements IPlugin {
  /** The name of the plugin */
  name = 'Released Label';

  /** The options of the plugin */
  readonly options: IReleasedLabelPluginOptions;

  /** Initialize the plugin with it's options */
  constructor(options: Partial<IReleasedLabelPluginOptions> = {}) {
    this.options = merge(defaultOptions, options);
  }

  /** Tap into auto plugin points. */
  apply(auto: Auto) {
    auto.hooks.modifyConfig.tap(this.name, config => {
      config.labels.released = config.labels.released || {
        name: 'released',
        description: 'This issue/pull request has been released.'
      };

      return config;
    });

    auto.hooks.afterRelease.tapPromise(
      this.name,
      async ({ newVersion, commits }) => {
        if (!newVersion) {
          return;
        }

        if ('dryRun' in auto.options && auto.options.dryRun) {
          return;
        }

        const head = commits[0];

        if (!head) {
          return;
        }

        const isSkipped = head.labels.find(label =>
          auto.release!.options.skipReleaseLabels.includes(label)
        );

        if (isSkipped) {
          return;
        }

        await Promise.all(
          commits.map(async commit =>
            this.addReleased(auto, commit, newVersion)
          )
        );
      }
    );
  }

  /** Add the release label + other stuff to a commit */
  private async addReleased(
    auto: Auto,
    commit: IExtendedCommit,
    newVersion: string
  ) {
    const messages = [commit.subject];

    if (commit.pullRequest) {
      await this.addCommentAndLabel(
        auto,
        newVersion,
        commit.pullRequest.number
      );

      const pr = await auto.git!.getPullRequest(commit.pullRequest.number);
      pr.data.body.split('\n').map(line => messages.push(line));

      const commitsInPr = await auto.git!.getCommitsForPR(
        commit.pullRequest.number
      );
      commitsInPr.map(c => messages.push(c.commit.message));
    }

    const issues = messages
      .map(message => message.match(closeIssue))
      .filter((r): r is string[] => Boolean(r))
      .reduce((all, arr) => [...all, ...arr], [])
      .map(issue => issue.match(/#(\d+)/i))
      .filter((r: RegExpMatchArray | null): r is RegExpMatchArray => Boolean(r))
      .map(match => Number(match[1]));

    await Promise.all(
      issues.map(async issue => {
        await this.addCommentAndLabel(auto, newVersion, issue, true);

        if (this.options.lockIssues && !isCanary(newVersion)) {
          await auto.git!.lockIssue(issue);
        }
      })
    );
  }

  /** Add the templated comment to the pr and attach the "released" label */
  private async addCommentAndLabel(
    auto: Auto,
    newVersion: string,
    prOrIssue: number,
    isIssue = false
  ) {
    // leave a comment with the new version
    const message = this.createReleasedComment(isIssue, newVersion);
    await auto.comment({ message, pr: prOrIssue, context: 'released' });

    // Do not add released to issue/label for canary versions
    if (isCanary(newVersion)) {
      return;
    }

    // add a `released` label to a PR
    const labels = await auto.git!.getLabels(prOrIssue);

    if (!labels.includes(this.options.label)) {
      await auto.git!.addLabelToPr(prOrIssue, this.options.label);
    }
  }

  /** Create a comment that fits the context (pr of issue) */
  private createReleasedComment(isIssue: boolean, version: string) {
    return this.options.message
      .replace(new RegExp(TYPE, 'g'), isIssue ? 'Issue' : 'PR')
      .replace(new RegExp(VERSION, 'g'), version);
  }
}
