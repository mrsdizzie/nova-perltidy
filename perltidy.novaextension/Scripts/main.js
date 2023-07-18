let commandRegister = null;
let perltidyExecutable = nova.config.get("com.mrsdizzie.perltidyExecPath");
let perltidyArgs = nova.config.get("com.mrsdizzie.perltidyArgs");
let formatOnSave = nova.config.get("com.mrsdizzie.perltidyRunOnSave");

let parsedPerltidyArgs = [];
if (perltidyArgs) {
  parsedPerltidyArgs = perltidyArgs.split(" ");
} else {
  // print to stderr (for issue capture) if no default is set
  parsedPerltidyArgs.push("-se");
}

const pertidyIssueCollection = new IssueCollection("perltidy");

const notify = (body) => {
  const request = new NotificationRequest("perltidy");
  request.title = nova.localize("perltidy");
  request.body = nova.localize(body);
  nova.notifications.add(request);
};

const observablePerltidyExecPath = nova.config.observe(
  "com.mrsdizzie.perltidyExecPath",
  (newPerltidyExecutable) => {
    perltidyExecutable = newPerltidyExecutable;
  }
);

const observablePerltidyArgs = nova.config.observe(
  "com.mrsdizzie.perltidyArgs",
  (newPerltidyArgs) => {
    perltidyArgs = newPerltidyArgs;
  }
);

const observableFormatOnSave = nova.config.observe(
  "com.mrsdizzie.perltidyRunOnSave",
  (newValue) => {
    formatOnSave = newValue ? true : false;
  }
);

exports.activate = function () {
  commandRegister = nova.commands.register("perltidy.run", (workspace) => {
    tidy(workspace);
  });

  nova.workspace.onDidAddTextEditor((editor) => {
    editor.onWillSave((editor) => {
      if (!editor.document.syntax.includes("perl")) return;
      if (! formatOnSave) return;

      const documentSpan = new Range(0, editor.document.length);
      const unformattedText = editor.document.getTextInRange(documentSpan);

      return applyFormattingAndProcessErrors(editor, documentSpan, unformattedText);
    });
  });

};



exports.deactivate = function () {
  observablePerltidyExecPath && observablePerltidyExecPath.dispose();
  commandRegister && commandRegister.dispose();
  observablePerltidyArgs && observablePerltidyArgs.dispose();
  observableFormatOnSave && observableFormatOnSave.dispose();
  pertidyIssueCollection && pertidyIssueCollection.dispose();
};

function tidy(workspace) {
  // If not set, we are run from the editor menu which has a slightly different context
  const currentEditor = workspace.activeTextEditor || workspace;

  let unformattedText = "";
  let rangeToReplace = null;
  let isSelection = false;

  if (currentEditor.selectedText) {
    // Don't add a newline at the end of a selection
    parsedPerltidyArgs.push("-natnl");
    isSelection = true;
    unformattedText = currentEditor.selectedText;
    rangeToReplace = currentEditor.selectedRange;
  } else {
    rangeToReplace = new Range(0, currentEditor.document.length);
    unformattedText = currentEditor.document.getTextInRange(rangeToReplace);
  }

  return applyFormattingAndProcessErrors(currentEditor, rangeToReplace, unformattedText, isSelection);
}

const formatText = (unformattedText, isSelection = false) => {
  if (!perltidyExecutable) {
    nova.workspace.showErrorMessage("Configure perltidy before running");
    return;
  }
  const writeToStdin = (process, unformattedText) => {
    const writer = process.stdin.getWriter();
    writer.ready.then(() => {
      writer.write(unformattedText);
      writer.close();
    });
  }

  const collectOutputText = (stdout, buffer) => (buffer.stdout += stdout);
  const collectErrorText = (stderr, buffer) => (buffer.stderr += stderr);

  const localPerltidyArgs = [...parsedPerltidyArgs];
  if (isSelection) {
    localPerltidyArgs.push("-natnl");
  }

  return new Promise((resolve, reject) => {
    try {
      const process = new Process(perltidyExecutable, {
        args: localPerltidyArgs,
      });
      const buffer = { stdout: "", stderr: "" };

      process.onStdout((stdout) => collectOutputText(stdout, buffer));
      process.onStderr((stderr) => collectErrorText(stderr, buffer));
      process.onDidExit((status) => {
        if (status === 0) {
          resolve(buffer.stdout);
        } else {
          reject({
            stderr: buffer.stderr,
            stdout: buffer.stdout
          });
        }
      });

      writeToStdin(process, unformattedText);
      process.start();
    } catch (err) {
      reject(err);
    }
  });
}

function applyFormattingAndProcessErrors(editor, rangeToReplace, unformattedText, isSelection = false) {
  return formatText(unformattedText, isSelection)
    .then((formattedText) => {
      editor.edit((edit) => edit.replace(rangeToReplace, formattedText));
      IssueManager.clearIssues();
    })
    .catch((error) => {
      const issues = IssueManager.generate(error.stderr, error.stdout);
      if (issues) {
        IssueManager.addIssues(editor.document.uri, issues);
      }
    });
}


const IssueManager = {

  collection: new IssueCollection("perltidy"),

  generate: function(errorText, stdin) {
    const issues = [];
    const errors = this.splitErrors(errorText);
    errors.forEach((error) => {
      const issue = this.createFromError(error, stdin);
      if (issue && issue.line) {
        issues.push(issue);
      }
    });

    return issues;
  },

  getContentsFromLine: function(lineNum, text) {
    const eol = nova.workspace.activeTextEditor.document.eol || "\n";
    const line = text.split(eol)[lineNum - 1];
    return line;
  },

   createFromError: function(errorText, text) {
    // these errors aren't helpful don't create issues for them
    if (errorText.includes("To save a full .LOG")) {
      return null;
    }

    const issue = new Issue();

    issue.message = "";
    issue.source = "perltidy";
    issue.severity = IssueSeverity.Error;

    const lines = errorText.split("\n");
    let offset = 0;
    let lineNumberOffset = 0;
    let ellipseOffset = 0;
    let lineNumber = null;
    const lineNumberRegex = /^\s*(\d+):/s;
    const truncatedLeadingErrorLineRegex = /^\s*\.\.\.\s/;
    const truncatedTrailingErrorLineRegex = /\s*\.\.\.$/;
    const onlyDashesAndCaretRegex = /^\s*[-]+[\^]$/;
    const onlyCaretRegex = /^[\s^]+$/;

    for (let i = 0; i < lines.length; i++) {
      // If there is no : this is not from perltidy and probably a perl warning about something unrelated
      if (!lines[i].includes(":")) {
        continue;
      }
      // not helpful, usually after a single line has already given 2 errors
      if (lines[i].includes("Giving up after error")) {
        return null;
      }

      // remove filename from error lines
      let line = lines[i].replace("<stdin>:", "");

      // remove line numbers
      line = line.replace(lineNumberRegex, function (match, group1) {
        lineNumber = group1.trim();
        lineNumberOffset = match.length;
        return "";
      });

      if (line.trim() === "") {
        continue;
      }

      const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
      let skipLineContent = false;

      // if the next line has a caret this line is just a piece of code we can already see in the editor and not error text
      // the next line with the caret points to the problem code
      if (nextLine && nextLine.indexOf("^") !== -1) {
        skipLineContent = true;
      }

      if (onlyDashesAndCaretRegex.test(line)) {
        let start = line.indexOf("-");
        let end = line.indexOf("^");
        if (offset !== -1) {
          // Account for the line number we removed from line [lineNumber: ... ]
          offset = offset - lineNumberOffset;
          if (offset > 0) {
            offset = offset - ellipseOffset;
          }
          start = offset + start;
          end = offset + end;
        }
        issue.column = start;
        issue.endColumn = end;
        continue;
      }

      if (onlyCaretRegex.test(line)) {
        const caretPosition = line.indexOf("^");
        if (caretPosition !== -1) {
          offset = offset - lineNumberOffset;
          if (offset > 0) {
            offset = offset - ellipseOffset;
          }
          issue.column = caretPosition + offset;
          continue;
        }
      }

      line = line.trim();

      if (lineNumber) {
        issue.line = lineNumber;
        // perltidy will sometimes truncate the line containing specific code if it is long. ex:
        // 33: ... cessful logins for $domain" } );
        //                            -------^
        // since we rely on the index of the caret to get the correct column number, we need to figure out
        // the offset of what perltidy has removed above. We already recorded the entire file from stdout, so look up
        // this specific line number and see where the code we can see starts and consider that the offset

        if (truncatedLeadingErrorLineRegex.test(line)) {
          const searchText = line.replace(
            truncatedLeadingErrorLineRegex,
            function (match) {
              ellipseOffset = match.length;
              return "";
            }
          );
          // long lines might have a trailing ... as well, but we don't want or need that
          searchText.replace(truncatedTrailingErrorLineRegex, "");
          const originalLineText = this.getContentsFromLine(lineNumber, text);
          offset = originalLineText.indexOf(searchText);
        }

        if (skipLineContent) {
          continue;
        }

        issue.message = issue.message + line;
      }
    }

    if (issue.line) {
      if (issue.message === "") {
        issue.message = "Unknown error";
      }
      return issue;
    } else {
      return null;
    }
  },

  splitErrors: function (errorText) {
    const lines = errorText.split("\n");
    const blocks = [];
    let currentBlock = "";
    const lineNumberPattern = /^<stdin>*:\s?(\d+):/;

    for (const line of lines) {
      if (lineNumberPattern.test(line)) {
        blocks.push(currentBlock.trim());
        currentBlock = "";
      }
      currentBlock += line + "\n";
    }
    if (currentBlock !== "") {
      blocks.push(currentBlock.trim());
    }
    return blocks;
  },

  clearIssues: function() {
    this.collection.clear();
    nova.notifications.cancel("perltidy");
  },

  addIssues: function(uri, issues) {
    this.collection.set(uri, issues);
    notify("Error while formatting, check issues pane");
  },

}
