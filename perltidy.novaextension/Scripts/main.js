let commandRegister = null;
let perltidyExecutable = nova.config.get("com.mrsdizzie.perltidyExecPath");
let perltidyArgs = nova.config.get("com.mrsdizzie.perltidyArgs");
let formatOnSave = nova.config.get("com.mrsdizzie.perltidyRunOnSave");

let pertidyIssueCollection = new IssueCollection("perltidy");

const notify = (body) => {
  let request = new NotificationRequest("perltidy");
  request.title = nova.localize("perltidy");
  request.body = nova.localize(body);
  nova.notifications.add(request);
};

let observablePerltidyExecPath = nova.config.observe(
  "com.mrsdizzie.perltidyExecPath",
  (newPerltidyExecutable) => {
    perltidyExecutable = newPerltidyExecutable;
  }
);

let observablePerltidyArgs = nova.config.observe(
  "com.mrsdizzie.perltidyArgs",
  (newPerltidyArgs) => {
    perltidyArgs = newPerltidyArgs;
  }
);

let observableFormatOnSave = nova.config.observe(
  "com.mrsdizzie.perltidyRunOnSave",
  (newValue) => {
    formatOnSave = newValue ? true : false;
  }
);

exports.activate = function () {
  commandRegister = nova.commands.register("perltidy.run", (workspace) => {
    tidy(workspace);
  });

  nova.workspace.activeTextEditor.onWillSave(async (editor) => {
    if (formatOnSave) {
      tidy(editor);
    }
    return "";
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
  let currentEditor = workspace.activeTextEditor || workspace;

  if (!perltidyExecutable) {
    nova.workspace.showErrorMessage("Configure perltidy before running");
    return;
  }

  let parsedPerltidyArgs = [];
  if (perltidyArgs) {
    parsedPerltidyArgs = perltidyArgs.split(" ");
  } else {
    // print to stderr (for issue capture) if no default is set
    parsedPerltidyArgs.push("-se");
  }

  let text = "";
  let errorText = "";
  let textToTidy = "";
  let rangeToReplace = null;

  if (currentEditor.selectedText) {
    // Don't add a newline at the end of a selection
    parsedPerltidyArgs.push("-natnl");
    textToTidy = currentEditor.selectedText;
    rangeToReplace = currentEditor.selectedRange;
  } else {
    rangeToReplace = new Range(0, currentEditor.document.length);
    textToTidy = currentEditor.document.getTextInRange(rangeToReplace);
  }

  try {
    let p = new Process(perltidyExecutable, {
      args: parsedPerltidyArgs,
    });

    // Send contents of editor to perltidy directly via STDIN rather than saving the file first
    const writer = p.stdin.getWriter();
    writer.ready.then(() => {
      writer.write(textToTidy);
      writer.close();
    });

    p.onStderr(function (line) {
      errorText = errorText + line;
    });

    p.onStdout(function (line) {
      text = text + line;
    });

    p.onDidExit(function (exitStatus) {
      if (exitStatus == 0) {
        currentEditor.edit((edit) => {
          edit.replace(rangeToReplace, text);
        });
        // clear all issues and notifications on successful format
        pertidyIssueCollection.clear();
        nova.notifications.cancel("perltidy");
      } else {
        let issues = [];
        let errors = splitErrors(errorText);
        errors.forEach((error) => {
          let issue = createIssueFromError(error, text);
          if (issue && issue.line) {
            issues.push(issue);
          }
        });
        if (issues) {
          pertidyIssueCollection.set(currentEditor.document.uri, issues);
          notify("Error while formatting, check issues pane");
        }
      }
    });

    p.start();
  } catch (err) {
    nova.workspace.showErrorMessage("Error running perltidy process.");
  }
}

function getContentsFromLine(lineNum, text) {
  let eol = nova.workspace.activeTextEditor.document.eol || "\n";
  let line = text.split(eol)[lineNum - 1];
  return line;
}

function createIssueFromError(errorText, text) {
  // these errors aren't helpful don't create issues for them
  if (errorText.includes("To save a full .LOG")) {
    return null;
  }

  let issue = new Issue();

  issue.message = "";
  issue.source = "perltidy";
  issue.severity = IssueSeverity.Error;

  let lines = errorText.split("\n");
  let offset = 0;
  let lineNumberOffset = 0;
  let ellipseOffset = 0;
  let lineNumber = null;
  let lineNumberRegex = /^\s*(\d+):/s;
  let truncatedLeadingErrorLineRegex = /^\s*\.\.\.\s/;
  let truncatedTrailingErrorLineRegex = /\s*\.\.\.$/;
  let onlyDashesAndCaretRegex = /^\s*[-]+[\^]$/;
  let onlyCaretRegex = /^[\s^]+$/;

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

    let nextLine = i + 1 < lines.length ? lines[i + 1] : null;
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
      let caretPosition = line.indexOf("^");
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
        let searchText = line.replace(
          truncatedLeadingErrorLineRegex,
          function (match) {
            ellipseOffset = match.length;
            return "";
          }
        );
        // long lines might have a trailing ... as well, but we don't want or need that
        searchText.replace(truncatedTrailingErrorLineRegex, "");
        let originalLineText = getContentsFromLine(lineNumber, text);
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
}

function splitErrors(errorText) {
  let lines = errorText.split("\n");
  let blocks = [];
  let currentBlock = "";
  let lineNumberPattern = /^<stdin>*:\s?(\d+):/;

  for (let line of lines) {
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
}
