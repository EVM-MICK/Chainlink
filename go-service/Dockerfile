# Use the official Golang image with Go 1.20
FROM golang:1.20

# Set the working directory inside the container
WORKDIR /app

# Clean module cache and download dependencies
RUN go clean -modcache

# Run go mod tidy to fix and fetch dependencies
RUN go mod tidy

# Download Go module dependencies
RUN go mod download

# Copy the entire project code into the container
COPY . .

# Build the Go application
RUN go build -o app.

# Set the default command to run the app
CMD ["./app"]

