export function Footer() {
  return (
    <footer className="wrap footer">
      <p>© {new Date().getFullYear()} Wild Hearts Health</p>
      <div className="footer-legal">
        <p>
          Wild Hearts Health is not a medical provider and does not give medical
          advice.
        </p>
        <p>MyChart is a registered trademark of Epic Systems Corporation.</p>
      </div>
    </footer>
  );
}
