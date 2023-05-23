# Perltidy for Nova

This extension provides integration with the [Perltidy](https://perltidy.sourceforge.net) formatter for the Nova text editor.

![](https://github.com/mrsdizzie/nova-perltidy/assets/1669571/cdfb2da9-ae7b-446f-9121-77c7b7bf6bd1)

## Requirements

The only requirement is Perltidy itself, which can be installed from the [official website](https://perltidy.sourceforge.net), CPAN, or Homebrew:

```shell
$ brew install perltidy
```

### Configuration

To configure global preferences, open **Extensions → Extension Library...** then select perltidy's **Preferences** tab. Note that this extension relies on parsing `STDOUT` and `STDERR` from Perltidy. If you include options to suppress those it will not work as expected.

## Usage

To run Perltidy:

- Open the command palette and type `perltidy`
- Select `perltidy` from the Editor menu

Perltidy will then format and replace the text in your current editor with a "tidy" version based on your configuration. If a block of text is selected, it will only format the selected text.

## Errors

This extension will not apply any changes if Perltidy returns an error code. Perltidy does provide specific error output when code is not valid Perl, but it is _not_ a linter. This extension attempts to capture and parse the Perltidy error output and convert it into issues within Nova:

![](https://github.com/mrsdizzie/nova-perltidy/assets/1669571/7c074f66-0826-46db-be89-1371a3d5f2c7)

This approach may yield mixed results; for example, a missing closing quote on line 30 might not manifest as a Perltidy error until the next quote appears on line 200. Depending on the problem, the errors may seem random and unrelated to the initial cause.

<a href="https://www.flaticon.com/free-icons/camel" title="camel icon">Camel icon created by Vector Stall - Flaticon</a>
