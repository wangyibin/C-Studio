# Current limitations

C-Studio is under active development. Keep these boundaries in mind:

- Desktop builds target macOS Apple Silicon / Intel, Windows x86-64, and Linux
  x86-64. macOS packages are not notarized and Windows packages are unsigned.
  Linux builds use Ubuntu 22.04 as their baseline and require a graphical desktop;
  Linux ARM64 desktop packages are not provided.
- **Load example project** requires a source checkout; packaged applications
  should load example files individually.
- C-Studio exports edited AGP files and their optional history sidecars, but
  does not currently export FASTA.
- The edited AGP is authoritative. Contact maps, PAF, coverage, and GFA assist
  review, but every edit requires user confirmation and still needs independent
  biological validation.
