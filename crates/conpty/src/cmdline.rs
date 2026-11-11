//! Windows command-line construction following the MSVC C runtime
//! `CommandLineToArgvW` parsing rules.

use crate::{PtyError, Result};

/// Append `arg` to `out`, quoting and escaping it so that the MSVC runtime
/// parses it back as exactly one argument.
pub fn quote_arg(arg: &str, out: &mut String) {
    let needs_quotes = arg.is_empty()
        || arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{0b}' | '"'));
    if !needs_quotes {
        out.push_str(arg);
        return;
    }

    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Escape all preceding backslashes plus the quote itself.
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote must be doubled.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// Build the full command line (program + arguments).
pub fn build_command_line(program: &str, args: &[String]) -> Result<String> {
    if program.trim().is_empty() {
        return Err(PtyError::EmptyProgram);
    }
    if program.contains('\0') || args.iter().any(|a| a.contains('\0')) {
        return Err(PtyError::NulInArgument);
    }
    let mut line = String::new();
    // The program name is parsed with simpler rules (no escapes): quote it if
    // it contains whitespace. Paths cannot contain '"' on Windows.
    if program.contains([' ', '\t']) {
        line.push('"');
        line.push_str(program);
        line.push('"');
    } else {
        line.push_str(program);
    }
    for arg in args {
        line.push(' ');
        quote_arg(arg, &mut line);
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(s: &str) -> String {
        let mut out = String::new();
        quote_arg(s, &mut out);
        out
    }

    #[test]
    fn plain_args_are_untouched() {
        assert_eq!(q("hello"), "hello");
        assert_eq!(q(r"C:\path\to"), r"C:\path\to");
    }

    #[test]
    fn empty_and_spaces_are_quoted() {
        assert_eq!(q(""), "\"\"");
        assert_eq!(q("a b"), "\"a b\"");
    }

    #[test]
    fn quotes_and_backslashes_are_escaped() {
        assert_eq!(q(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(q(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(q(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn injection_attempt_stays_one_argument() {
        // A naive join would let `& calc` become a second command for cmd.exe;
        // with correct quoting the whole value is one argv entry.
        let line = build_command_line("prog.exe", &["x\" & calc & \"".into()]).unwrap();
        assert_eq!(line, r#"prog.exe "x\" & calc & \"""#);
    }

    #[test]
    fn program_with_space_is_quoted() {
        let line =
            build_command_line(r"C:\Program Files\Git\bin\bash.exe", &["--login".into()]).unwrap();
        assert_eq!(line, r#""C:\Program Files\Git\bin\bash.exe" --login"#);
    }

    #[test]
    fn rejects_empty_and_nul() {
        assert!(build_command_line("  ", &[]).is_err());
        assert!(build_command_line("a", &["b\0".into()]).is_err());
    }
}
