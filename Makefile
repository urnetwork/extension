all: clean build

clean:
	rm -rf release

build:
	npm ci
	npm run build
	npm run build:firefox
