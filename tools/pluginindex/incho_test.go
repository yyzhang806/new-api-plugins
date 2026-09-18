package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"gopkg.in/yaml.v3"
)

func TestIncho110Fixture(t *testing.T) {
	source, err := os.ReadFile("../../plugins/tasks/incho/1.1.0/plugin.js")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile("../../tests/incho/1.1.0.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	report, err := jsplugin.ReplayFixture(context.Background(), string(source), fixture)
	if err != nil {
		t.Fatalf("%d/%d passed: %v", report.Passed, report.Total, err)
	}
	t.Logf("%d/%d host-runtime cases passed", report.Passed, report.Total)
}

func TestIncho110Changelogs(t *testing.T) {
	dir := "../../plugins/tasks/incho/1.1.0"
	categories := []string{"Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Migration"}
	var englishSections []string
	var englishCounts []int
	for _, locale := range []string{"en", "zh-CN"} {
		name := "CHANGELOG.md"
		if locale != "en" {
			name = "CHANGELOG." + locale + ".md"
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.SplitN(string(data), "---\n", 3)
		if len(parts) != 3 || parts[0] != "" {
			t.Fatalf("%s: invalid front matter", name)
		}
		var meta struct {
			ChangelogVersion int               `yaml:"changelogVersion"`
			Plugin           string            `yaml:"plugin"`
			Version          string            `yaml:"version"`
			Locale           string            `yaml:"locale"`
			Translations     map[string]string `yaml:"translations"`
		}
		decoder := yaml.NewDecoder(strings.NewReader(parts[1]))
		decoder.KnownFields(true)
		if err := decoder.Decode(&meta); err != nil {
			t.Fatal(err)
		}
		if meta.ChangelogVersion != 1 || meta.Plugin != "incho" || meta.Version != "1.1.0" || meta.Locale != locale {
			t.Fatalf("%s: mismatched metadata", name)
		}
		if locale == "en" && meta.Translations["zh-CN"] != "CHANGELOG.zh-CN.md" {
			t.Fatal("missing translation discovery")
		}
		if locale != "en" && len(meta.Translations) != 0 {
			t.Fatal("translations map belongs only in English")
		}
		body := "\n" + parts[2]
		if strings.Count(body, "\n# Changelog\n") != 1 || strings.Count(body, "\n## [1.1.0]\n") != 1 {
			t.Fatalf("%s: invalid release headings", name)
		}
		var sections []string
		var counts []int
		last, current := -1, -1
		for _, line := range strings.Split(body, "\n") {
			if strings.HasPrefix(line, "### ") {
				category := strings.TrimPrefix(line, "### ")
				index := -1
				for i, allowed := range categories {
					if category == allowed {
						index = i
					}
				}
				if index <= last || index < 0 {
					t.Fatalf("%s: invalid category %s", name, category)
				}
				last = index
				current++
				sections = append(sections, category)
				counts = append(counts, 0)
			} else if strings.HasPrefix(line, "- ") {
				if current < 0 || strings.TrimSpace(strings.TrimPrefix(line, "- ")) == "" {
					t.Fatal("invalid bullet")
				}
				counts[current]++
			} else if strings.TrimSpace(line) != "" && line != "# Changelog" && line != "## [1.1.0]" {
				t.Fatalf("%s: unsupported Markdown structure: %s", name, line)
			}
		}
		for _, count := range counts {
			if count == 0 {
				t.Fatal("empty category")
			}
		}
		if !regexp.MustCompile(`(?m)^### (Added|Changed|Deprecated|Removed|Fixed|Security)$`).MatchString(body) {
			t.Fatal("no release changes")
		}
		if locale == "en" {
			englishSections, englishCounts = sections, counts
		} else if !reflect.DeepEqual(sections, englishSections) || !reflect.DeepEqual(counts, englishCounts) {
			t.Fatal("translation categories or entries differ")
		}
	}
}
