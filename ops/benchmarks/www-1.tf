resource "digitalocean_droplet" "www-1" {
  image = "ubuntu-18-04-x64"
  name = "www-1"
  region = "sfo3"
  size = "s-2vcpu-4gb"
  private_networking = true
  ssh_keys = [
    data.digitalocean_ssh_key.benchmark-ssh.id
  ]
  connection {
    host = self.ipv4_address
    user = "root"
    type = "ssh"
    timeout = "2m"
  }
}

output "instance_ip" {
    value = digitalocean_droplet.www-1.ipv4_address 
}